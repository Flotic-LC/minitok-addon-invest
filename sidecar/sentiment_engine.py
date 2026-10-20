"""
Financial Sentiment Engine - FinGPT-style news sentiment for Korean/US equities.

Sources (fail-open, no external API key required):
  - Google News RSS  (query by symbol / company name)   [primary, free]
  - Naver Finance    (per-symbol news board scrape)     [KR symbols]
  - DART disclosure  (optional, requires DART_API_KEY)  [stub]

Scoring:
  - Default: keyword-based lexicon (Korean + English) -> score in [-1, +1]
  - Optional LLM hook: set SENTIMENT_LLM_URL to delegate classify_sentiment

Result is cached in-memory (TTL) and exposed to the runner for prompt context.
"""

import logging
import os
import re
import time
import json
import threading
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)

DEFAULT_CACHE_DIR = os.getenv("CACHE_DIR", "data/cache")
CACHE_TTL = int(os.getenv("SENTIMENT_CACHE_TTL", "1800"))  # 30 min
NEWS_LOOKBACK_HOURS = int(os.getenv("SENTIMENT_LOOKBACK_HOURS", "24"))
MAX_ARTICLES = int(os.getenv("SENTIMENT_MAX_ARTICLES", "20"))
HTTP_TIMEOUT = int(os.getenv("SENTIMENT_HTTP_TIMEOUT", "6"))
DART_API_KEY = os.getenv("DART_API_KEY", "")

_UA = {"User-Agent": "Mozilla/5.0 (minitok-sentiment/1.4.0)"}

# ---------------------------------------------------------------------------
# Lexicon (KR + EN). Weight: strong=2, normal=1. Extend as needed.
# ---------------------------------------------------------------------------
_POS = {
    # Korean
    "상승": 1, "급등": 2, "강세": 1, "호실적": 2, "흑자": 1, "최고치": 2,
    "신고가": 2, "돌파": 1, "성장": 1, "호재": 2, "수주": 1, "계약": 1,
    "증가": 1, "개선": 1, "기대": 1, "긍정": 1, "매수": 1, "목표가 상향": 2,
    "실적 발표": 1, "어닝 서프라이즈": 2, "배당": 1, "자사주": 1, "신제품": 1,
    "승인": 1, "허가": 1, "협력": 1, "투자 유치": 1, "상승세": 1, "반등": 1,
    # English
    "surge": 2, "beat": 1, "upgrade": 1, "record": 2, "growth": 1,
    "profit": 1, "rally": 1, "bullish": 1, "soar": 2, "gain": 1,
    "outperform": 1, "buy": 1, "raises": 1, "expands": 1, "wins": 1,
}
_NEG = {
    # Korean
    "하락": 1, "급락": 2, "약세": 1, "적자": 1, "손실": 1, "최저치": 2,
    "신저가": 2, "붕괴": 2, "악재": 2, "감소": 1, "악화": 1, "우려": 1,
    "부정": 1, "매도": 1, "목표가 하향": 2, "어닝 쇼크": 2, "리콜": 1,
    "소송": 1, "제재": 1, "과징금": 1, "횡령": 2, "배임": 2, "유상증자": 1,
    "하향": 1, "폭락": 2, "거래정지": 2, "상장폐지": 2, "관리종목": 2,
    # English
    "plunge": 2, "miss": 1, "downgrade": 1, "loss": 1, "fall": 1,
    "drop": 1, "bearish": 1, "crash": 2, "sell": 1, "cuts": 1,
    "underperform": 1, "warning": 1, "lawsuit": 1, "recall": 1, "fraud": 2,
}

# Key event patterns -> human-readable labels (surfaced as key_events)
_EVENT_PATTERNS = [
    (r"(실적|어닝|매출|영업이익).{0,12}(발표|예정|공시)", "실적 발표 예정"),
    (r"(신제품|신모델|출시|론칭|런칭)", "신제품 출시"),
    (r"(수주|계약 체결|공급 계약)", "수주/계약"),
    (r"(배당|자사주|주주환원)", "주주환원 정책"),
    (r"(유상증자|무상증자|전환사채)", "자본 조달"),
    (r"(인수|합병|M&A|지분 인수)", "M&A"),
    (r"(소송|제재|과징금|조사|검찰)", "규제/법적 리스크"),
    (r"(승인|허가|임상)", "인허가/승인"),
    (r"(목표가|리포트|커버리지)", "애널리스트 리포트"),
]

# Well-known KR symbol -> company name (for news query). Extend as needed.
_KR_NAMES = {
    "005930": "삼성전자", "000660": "SK하이닉스", "035720": "카카오",
    "035420": "네이버", "051910": "LG화학", "006400": "삼성SDI",
    "005380": "현대차", "068270": "셀트리온", "207940": "삼성바이오로직스",
    "005490": "POSCO홀딩스", "105560": "KB금융", "055550": "신한지주",
}


class FinancialSentiment:
    """News sentiment scorer with in-memory caching. Fail-open everywhere."""

    def __init__(self, cache_dir: str = DEFAULT_CACHE_DIR):
        self.cache_dir = cache_dir
        self._cache: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()
        os.makedirs(cache_dir, exist_ok=True)
        logger.info(f"FinancialSentiment initialized (ttl={CACHE_TTL}s, lookback={NEWS_LOOKBACK_HOURS}h, dart={'ok' if DART_API_KEY else 'no-key'})")

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------

    def _http_get(self, url: str, timeout: int = HTTP_TIMEOUT) -> Optional[bytes]:
        try:
            req = urllib.request.Request(url, headers=_UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            logger.debug(f"sentiment http fail {url[:60]}: {e}")
            return None

    # ------------------------------------------------------------------
    # News fetchers
    # ------------------------------------------------------------------

    def _query_name(self, symbol: str) -> str:
        sym = str(symbol).upper().strip()
        return _KR_NAMES.get(sym, sym)

    def _fetch_google_news(self, symbol: str, limit: int) -> List[Dict[str, Any]]:
        name = self._query_name(symbol)
        q = urllib.parse.quote(f"{name} 주가" if re.match(r"^\d{6}$", symbol) else name)
        url = f"https://news.google.com/rss/search?q={q}&hl=ko&gl=KR&ceid=KR:ko"
        raw = self._http_get(url)
        if not raw:
            return []
        out = []
        try:
            root = ET.fromstring(raw)
            for item in root.iter("item"):
                title = (item.findtext("title") or "").strip()
                pub = (item.findtext("pubDate") or "").strip()
                if not title:
                    continue
                out.append({"title": title, "source": "google_news", "published": pub})
                if len(out) >= limit:
                    break
        except Exception as e:
            logger.debug(f"google news parse fail: {e}")
        return out

    def _fetch_naver(self, symbol: str, limit: int) -> List[Dict[str, Any]]:
        if not re.match(r"^\d{6}$", str(symbol)):
            return []
        url = f"https://finance.naver.com/item/news.naver?code={symbol}"
        raw = self._http_get(url)
        if not raw:
            return []
        out = []
        try:
            html = raw.decode("euc-kr", errors="ignore")
            # extract <a class="tit" ...>title</a> from newsSubject
            for m in re.finditer(r'class="tit"[^>]*>([^<]{4,120})<', html):
                t = re.sub(r"\s+", " ", m.group(1)).strip()
                if t:
                    out.append({"title": t, "source": "naver", "published": ""})
                if len(out) >= limit:
                    break
        except Exception as e:
            logger.debug(f"naver parse fail: {e}")
        return out

    def fetch_recent_news(self, symbol: str, hours: int = NEWS_LOOKBACK_HOURS) -> List[Dict[str, Any]]:
        """Aggregate recent headlines for a symbol (dedup by title)."""
        per = max(4, MAX_ARTICLES // 2)
        articles = []
        try:
            articles += self._fetch_google_news(symbol, per)
        except Exception as e:
            logger.debug(f"google fetch fail: {e}")
        try:
            articles += self._fetch_naver(symbol, per)
        except Exception as e:
            logger.debug(f"naver fetch fail: {e}")
        seen = set()
        dedup = []
        for a in articles:
            key = a["title"][:40]
            if key in seen:
                continue
            seen.add(key)
            dedup.append(a)
            if len(dedup) >= MAX_ARTICLES:
                break
        return dedup

    # ------------------------------------------------------------------
    # Classification
    # ------------------------------------------------------------------

    def classify_sentiment(self, article: Any) -> float:
        """
        Score one article title in [-1, +1].
        Keyword method: (sum_pos - sum_neg) / (sum_pos + sum_neg), normalized.
        """
        title = (article.get("title") if isinstance(article, dict) else str(article)) or ""
        text = title.lower()
        pos = 0.0
        neg = 0.0
        for kw, w in _POS.items():
            if kw.lower() in text:
                pos += w
        for kw, w in _NEG.items():
            if kw.lower() in text:
                neg += w
        total = pos + neg
        if total == 0:
            return 0.0
        return round((pos - neg) / total, 4)

    def _extract_events(self, titles: List[str]) -> List[str]:
        events = []
        for t in titles:
            for pat, label in _EVENT_PATTERNS:
                if re.search(pat, t) and label not in events:
                    events.append(label)
        return events[:5]

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def get_sentiment(self, symbol: str, force: bool = False) -> Dict[str, Any]:
        """
        Aggregate sentiment for a symbol. Cached for CACHE_TTL seconds.
        Returns {symbol, avg_sentiment, news_count, key_events, confidence,
                 label, method, cached, ts}.
        """
        sym = str(symbol).upper().strip()
        now = time.time()
        with self._lock:
            cached = self._cache.get(sym)
            if cached and not force and (now - cached.get("ts", 0)) < CACHE_TTL:
                out = dict(cached)
                out["cached"] = True
                return out

        articles = self.fetch_recent_news(sym)
        scores = []
        for a in articles:
            s = self.classify_sentiment(a)
            a["score"] = s
            scores.append(s)
        n = len(scores)
        avg = sum(scores) / n if n else 0.0
        nonzero = [s for s in scores if s != 0.0]
        # confidence: fraction of scored articles, scaled by volume
        confidence = 0.0
        if n:
            coverage = len(nonzero) / n
            volume = min(1.0, n / 10.0)
            confidence = round(0.4 * volume + 0.6 * coverage, 4)
        if avg > 0.15:
            label = "긍정적"
        elif avg < -0.15:
            label = "부정적"
        else:
            label = "중립"
        titles = [a["title"] for a in articles]
        result = {
            "symbol": sym,
            "avg_sentiment": round(avg, 4),
            "news_count": n,
            "key_events": self._extract_events(titles),
            "confidence": confidence,
            "label": label,
            "method": "keyword",
            "cached": False,
            "ts": now,
            "top_headlines": titles[:5],
        }
        with self._lock:
            self._cache[sym] = dict(result)
        logger.info(f"[sentiment] {sym}: score={result['avg_sentiment']} n={n} conf={confidence} label={label}")
        return result


