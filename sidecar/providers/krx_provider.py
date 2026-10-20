"""
KRX (Korea Exchange) Provider
Fetches KOSPI200 volatility estimate and KOSPI index level.

VKOSPI strategy:
- Primary: 30-day realized volatility of KOSPI200 ETF (148070.KS), annualized.
- Secondary: 30-day realized volatility of KOSPI index (^KS11).
- Failure: file-cached last good value, else hardcoded fallback.
"""

import logging
import math
from typing import Dict, Any, Optional, List
import requests

from cache import FileCache

logger = logging.getLogger(__name__)


class KRXProvider:
    """Provider for KRX market data with file-cache fallback."""

    YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    REQUEST_TIMEOUT = 10

    KOSPI200_PROXY_SYMBOL = "148070.KS"
    KOSPI_INDEX_SYMBOL = "^KS11"

    VOL_LOW_MAX = 15.0
    VOL_NORMAL_MAX = 25.0
    VOL_HIGH_MAX = 35.0

    CACHE_KEY_VOL = "krx_vkospi"
    CACHE_KEY_KOSPI = "krx_kospi"

    def __init__(self, cache: Optional[FileCache] = None):
        self.cache = cache or FileCache()
        logger.info("KRXProvider initialized")

    def get_kospi200_volatility(self) -> Optional[Dict[str, Any]]:
        """Get KOSPI200 volatility estimate (VKOSPI proxy)."""
        result = self._compute_realized_vol(
            symbol=self.KOSPI200_PROXY_SYMBOL,
            label="KOSPI200 ETF (148070.KS)",
        )
        if result is not None:
            self.cache.set(self.CACHE_KEY_VOL, result, source="krx")
            return result

        logger.info("KOSPI200 proxy failed, falling back to KOSPI index")
        result = self._compute_realized_vol(
            symbol=self.KOSPI_INDEX_SYMBOL,
            label="KOSPI index (^KS11)",
        )
        if result is not None:
            self.cache.set(self.CACHE_KEY_VOL, result, source="krx")
            return result

        # Try file cache
        cached = self._cached_or_none(self.CACHE_KEY_VOL, "VKOSPI")
        if cached is not None:
            return cached

        logger.warning("All volatility sources failed - using hardcoded fallback")
        return self._get_volatility_fallback()

    def get_kospi_index(self) -> Optional[Dict[str, Any]]:
        """Get current KOSPI index level with cache fallback."""
        try:
            closes = self._fetch_yahoo_closes(self.KOSPI_INDEX_SYMBOL, range_param="5d")
            if not closes:
                return self._cached_or_none(self.CACHE_KEY_KOSPI, "KOSPI")
            result = {
                "value": closes[-1],
                "source": "yahoo",
                "symbol": self.KOSPI_INDEX_SYMBOL,
            }
            self.cache.set(self.CACHE_KEY_KOSPI, result, source="krx")
            return result
        except Exception as e:
            logger.error(f"Error fetching KOSPI index: {e}")
            return self._cached_or_none(self.CACHE_KEY_KOSPI, "KOSPI")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_yahoo_closes(
        self,
        symbol: str,
        range_param: str = "3mo",
        interval: str = "1d",
    ) -> List[float]:
        """Fetch daily closes from Yahoo Finance. Returns [] on failure."""
        url = self.YAHOO_CHART_URL.format(symbol=symbol)
        params = {"interval": interval, "range": range_param}
        headers = {"User-Agent": self.USER_AGENT}

        try:
            resp = requests.get(url, params=params, headers=headers, timeout=self.REQUEST_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
        except requests.RequestException as e:
            logger.warning(f"Yahoo request failed for {symbol}: {e}")
            return []
        except ValueError as e:
            logger.warning(f"Yahoo invalid JSON for {symbol}: {e}")
            return []

        try:
            result = data["chart"]["result"][0]
            closes = result["indicators"]["quote"][0]["close"]
        except (KeyError, IndexError, TypeError) as e:
            logger.warning(f"Yahoo unexpected response shape for {symbol}: {e}")
            return []

        return [c for c in closes if c is not None and c > 0]

    def _compute_realized_vol(
        self,
        symbol: str,
        label: str,
        window: int = 30,
    ) -> Optional[Dict[str, Any]]:
        """Compute annualized realized volatility from Yahoo daily closes."""
        try:
            closes = self._fetch_yahoo_closes(symbol, range_param="3mo")
            if len(closes) < window + 1:
                logger.warning(
                    f"Insufficient data for {label}: got {len(closes)} bars, need {window + 1}"
                )
                return None

            log_returns = [
                math.log(closes[i] / closes[i - 1])
                for i in range(1, len(closes))
            ]
            recent = log_returns[-window:]

            n = len(recent)
            mean = sum(recent) / n
            variance = sum((r - mean) ** 2 for r in recent) / (n - 1)
            daily_std = math.sqrt(variance)
            annualized_vol = daily_std * math.sqrt(252) * 100.0

            regime = self._classify_regime(annualized_vol)
            logger.info(
                f"Realized vol for {label}: {annualized_vol:.2f}% "
                f"(regime={regime}, bars={len(closes)})"
            )

            return {
                "value": round(annualized_vol, 2),
                "regime": regime,
                "source": "yahoo_realized_vol",
                "symbol": symbol,
                "window_days": window,
                "bars_used": len(closes),
                "note": f"30-day realized volatility of {label}, annualized",
            }

        except Exception as e:
            logger.error(f"Error computing realized vol for {label}: {e}")
            return None

    def _classify_regime(self, vol_pct: float) -> str:
        """Classify volatility regime based on annualized vol %."""
        if vol_pct < self.VOL_LOW_MAX:
            return "low"
        elif vol_pct < self.VOL_NORMAL_MAX:
            return "normal"
        elif vol_pct < self.VOL_HIGH_MAX:
            return "high"
        else:
            return "extreme"

    def _cached_or_none(self, cache_key: str, label: str) -> Optional[Dict[str, Any]]:
        """Return cached value marked as from_cache, or None."""
        cached = self.cache.get_with_metadata(cache_key)
        if cached is None:
            return None
        value = cached.get("value")
        if value is None:
            return None
        result = dict(value)
        result["from_cache"] = True
        result["cached_at"] = cached.get("fetched_at")
        result["cache_age_seconds"] = self.cache.age_seconds(cache_key)
        logger.info(
            f"Using cached KRX value for {label} (age={result['cache_age_seconds']:.0f}s)"
        )
        return result

    def _get_volatility_fallback(self) -> Optional[Dict[str, Any]]:
        """Final fallback when all data sources fail (no cache available)."""
        logger.info("Using hardcoded fallback KOSPI200 volatility estimate")
        return {
            "value": 20.0,
            "regime": "normal",
            "source": "fallback",
            "note": "Estimated value - all data sources and cache unavailable",
        }
