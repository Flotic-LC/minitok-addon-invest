"""
Alpha Engine - Qlib Expression Engine style factor computation.

Computes 20 technical factors from OHLCV data and classifies market regime
using GaussianMixture (GMM) as a lightweight HMM alternative.

Design follows Qlib's expression pattern:
  - Each factor is a pure function of (close, high, low, volume) pandas Series
  - compute_signals(symbol) returns a flat dict of factor values
  - detect_regime(closes, returns) classifies market regime via GMM
"""

import logging
import math
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
import pandas as pd
import requests

logger = logging.getLogger(__name__)


class AlphaEngine:
    """
    Computes 20 alpha factors from OHLCV price data.
    Data source: yfinance (fallback) or Toss API (when wired).
    """

    YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
    USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

    REGIME_LABELS = ["trending_down", "sideways", "volatile", "trending_up"]

    def __init__(self):
        self._regime_model = None  # lazy-fitted GMM
        logger.info("AlphaEngine initialized")

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def compute_signals(self, symbol: str) -> Dict[str, Any]:
        """
        Compute all 20 alpha factors for a symbol.

        Returns dict with keys:
          - factors: dict of 20 factor values
          - regime: market regime classification
          - regime_confidence: probability of assigned regime
          - bars: number of price bars used
          - symbol: input symbol
          - source: data source identifier
        """
        df = self._fetch_ohlcv(symbol)
        if df is None or len(df) < 30:
            raise ValueError(f"Insufficient data for {symbol}: got {0 if df is None else len(df)} bars")

        factors = self._compute_all_factors(df)
        regime, regime_conf = self._detect_regime(df)

        return {
            "symbol": symbol,
            "factors": factors,
            "regime": regime,
            "regime_confidence": round(regime_conf, 4),
            "bars": len(df),
            "source": "yfinance",
        }

    def compute_batch(self, symbols: List[str]) -> Dict[str, Any]:
        """Compute signals for multiple symbols. Returns {symbol: result or error}."""
        results = {}
        for sym in symbols:
            try:
                results[sym] = self.compute_signals(sym)
            except Exception as e:
                logger.warning(f"Failed to compute signals for {sym}: {e}")
                results[sym] = {"error": str(e)}
        return results

    def summarize_for_llm(self, signals: Dict[str, Any]) -> str:
        """
        Produce a Korean-language summary of factor signals for LLM prompt injection.
        Example: "기술적 신호: 모멘텀 +3%, 변동성 높음, MACD 골든크로스, 국면: 상승추세"
        """
        f = signals.get("factors", {})
        parts: List[str] = []

        # Momentum
        mom = f.get("momentum_20d")
        if mom is not None:
            pct = mom * 100
            parts.append(f"모멘텀 {pct:+.1f}%")

        # Volatility
        vol = f.get("volatility_20d")
        if vol is not None:
            pct = vol * 100
            if pct < 1.0:
                label = "낮음"
            elif pct < 2.5:
                label = "보통"
            else:
                label = "높음"
            parts.append(f"변동성 {label}({pct:.1f}%)")

        # RSI
        rsi = f.get("rsi_14")
        if rsi is not None:
            if rsi > 70:
                parts.append(f"RSI 과매수({rsi:.0f})")
            elif rsi < 30:
                parts.append(f"RSI 과매도({rsi:.0f})")
            else:
                parts.append(f"RSI 중립({rsi:.0f})")

        # MACD
        macd_hist = f.get("macd_histogram")
        if macd_hist is not None:
            if macd_hist > 0:
                parts.append("MACD 골든크로스")
            elif macd_hist < 0:
                parts.append("MACD 데드크로스")

        # Bollinger position
        bb = f.get("bollinger_position")
        if bb is not None:
            if bb > 0.95:
                parts.append("볼린저 상단 근접")
            elif bb < 0.05:
                parts.append("볼린저 하단 근접")

        # ADX
        adx = f.get("trend_strength")
        if adx is not None:
            if adx > 25:
                parts.append(f"강한 추세(ADX {adx:.0f})")
            elif adx < 20:
                parts.append(f"약한 추세(ADX {adx:.0f})")

        # Regime
        regime_ko = {
            "trending_up": "상승추세",
            "trending_down": "하락추세",
            "sideways": "횡보",
            "volatile": "고변동",
        }.get(signals.get("regime", ""), "알수없음")
        conf = signals.get("regime_confidence", 0)
        parts.append(f"국면: {regime_ko}({conf:.0%})")

        return "기술적 신호: " + ", ".join(parts) if parts else "기술적 신호: 데이터 부족"

    # ------------------------------------------------------------------
    # Data fetching
    # ------------------------------------------------------------------

    def _fetch_ohlcv(self, symbol: str, range_param: str = "6mo") -> Optional[pd.DataFrame]:
        """Fetch OHLCV data. Returns DataFrame or None on failure."""
        yahoo_symbol = symbol.replace(".", "-")  # Yahoo uses BRK-B not BRK.B
        if symbol.isdigit() and len(symbol) == 6:
            yahoo_symbol = f"{symbol}.KS"

        url = self.YAHOO_CHART_URL.format(symbol=yahoo_symbol)
        params = {"interval": "1d", "range": range_param}
        headers = {"User-Agent": self.USER_AGENT}

        try:
            resp = requests.get(url, params=params, headers=headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except (requests.RequestException, ValueError) as e:
            logger.warning(f"Yahoo fetch failed for {yahoo_symbol}: {e}")
            return None

        try:
            result = data["chart"]["result"][0]
            quote = result["indicators"]["quote"][0]
            timestamps = result.get("timestamp", [])
            if not timestamps:
                return None

            df = pd.DataFrame({
                "open": quote.get("open", []),
                "high": quote.get("high", []),
                "low": quote.get("low", []),
                "close": quote.get("close", []),
                "volume": quote.get("volume", []),
            }, index=pd.to_datetime(timestamps, unit="s"))

            df = df.dropna(subset=["close"])
            df = df[df["close"] > 0]
            return df if len(df) > 0 else None

        except (KeyError, IndexError, TypeError) as e:
            logger.warning(f"Yahoo parse error for {yahoo_symbol}: {e}")
            return None

    # ------------------------------------------------------------------
    # Factor computation (20 factors)
    # ------------------------------------------------------------------

    def _compute_all_factors(self, df: pd.DataFrame) -> Dict[str, Optional[float]]:
        """Compute all 20 alpha factors."""
        close = df["close"]
        high = df["high"]
        low = df["low"]
        volume = df["volume"]

        factors: Dict[str, Optional[float]] = {}

        # Momentum (3)
        factors["momentum_5d"] = self._safe(lambda: close.iloc[-1] / close.iloc[-5] - 1 if len(close) >= 5 else None)
        factors["momentum_20d"] = self._safe(lambda: close.iloc[-1] / close.rolling(20).mean().iloc[-1] - 1)
        factors["momentum_60d"] = self._safe(lambda: close.iloc[-1] / close.rolling(60).mean().iloc[-1] - 1 if len(close) >= 60 else None)

        # Volatility (3)
        factors["volatility_20d"] = self._safe(lambda: close.rolling(20).std().iloc[-1] / close.rolling(20).mean().iloc[-1])
        factors["volatility_60d"] = self._safe(lambda: close.rolling(60).std().iloc[-1] / close.rolling(60).mean().iloc[-1] if len(close) >= 60 else None)
        factors["volatility_ratio"] = self._volatility_ratio(close)

        # Volume (3)
        factors["volume_price_corr"] = self._safe(lambda: close.rolling(10).corr(volume).iloc[-1])
        factors["volume_ratio_20d"] = self._safe(lambda: volume.iloc[-1] / volume.rolling(20).mean().iloc[-1] if volume.rolling(20).mean().iloc[-1] > 0 else None)
        factors["volume_momentum"] = self._safe(lambda: volume.rolling(5).mean().iloc[-1] / volume.rolling(20).mean().iloc[-1] if len(volume) >= 20 else None)

        # MACD (3)
        macd_line, macd_signal, macd_hist = self._macd(close)
        factors["macd"] = macd_line
        factors["macd_signal"] = macd_signal
        factors["macd_histogram"] = macd_hist

        # RSI (2)
        factors["rsi_14"] = self._rsi(close, 14)
        factors["rsi_7"] = self._rsi(close, 7)

        # Bollinger Bands (2)
        bb_pos, bb_width = self._bollinger(close)
        factors["bollinger_position"] = bb_pos
        factors["bollinger_width"] = bb_width

        # ADX (1)
        factors["trend_strength"] = self._adx(high, low, close, 14)

        # Price position (2)
        factors["price_position_52w"] = self._safe(lambda: (close.iloc[-1] - close.min()) / (close.max() - close.min()) if (close.max() - close.min()) > 0 else None)
        factors["distance_from_high_20d"] = self._safe(lambda: (close.iloc[-1] - close.rolling(20).max().iloc[-1]) / close.rolling(20).max().iloc[-1])

        # MA cross (2)
        factors["ma_cross_5_20"] = self._safe(lambda: close.rolling(5).mean().iloc[-1] / close.rolling(20).mean().iloc[-1] - 1)
        factors["ma_cross_20_60"] = self._safe(lambda: close.rolling(20).mean().iloc[-1] / close.rolling(60).mean().iloc[-1] - 1 if len(close) >= 60 else None)

        return factors

    # ------------------------------------------------------------------
    # Technical indicator helpers
    # ------------------------------------------------------------------

    def _safe(self, fn):
        """Execute fn, return None on any exception."""
        try:
            v = fn()
            if v is None:
                return None
            f = float(v)
            if math.isnan(f) or math.isinf(f):
                return None
            return round(f, 6)
        except Exception:
            return None

    def _volatility_ratio(self, close: pd.Series) -> Optional[float]:
        """5d vol / 20d vol - indicates volatility expansion/contraction."""
        try:
            v5 = close.rolling(5).std().iloc[-1]
            v20 = close.rolling(20).std().iloc[-1]
            if v20 and v20 > 0:
                return round(float(v5 / v20), 6)
            return None
        except Exception:
            return None

    def _ema(self, series: pd.Series, span: int) -> pd.Series:
        return series.ewm(span=span, adjust=False).mean()

    def _macd(self, close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> Tuple[Optional[float], Optional[float], Optional[float]]:
        """Return (macd_line, signal_line, histogram)."""
        try:
            ema_fast = self._ema(close, fast)
            ema_slow = self._ema(close, slow)
            macd_line = ema_fast - ema_slow
            signal_line = macd_line.ewm(span=signal, adjust=False).mean()
            hist = macd_line - signal_line
            return (
                round(float(macd_line.iloc[-1]), 6),
                round(float(signal_line.iloc[-1]), 6),
                round(float(hist.iloc[-1]), 6),
            )
        except Exception:
            return None, None, None

    def _rsi(self, close: pd.Series, period: int = 14) -> Optional[float]:
        """Wilder's RSI."""
        try:
            delta = close.diff()
            gain = delta.clip(lower=0)
            loss = -delta.clip(upper=0)
            avg_gain = gain.ewm(alpha=1/period, adjust=False, min_periods=period).mean()
            avg_loss = loss.ewm(alpha=1/period, adjust=False, min_periods=period).mean()
            rs = avg_gain / avg_loss
            rsi = 100 - (100 / (1 + rs))
            v = rsi.iloc[-1]
            if math.isnan(v):
                return None
            return round(float(v), 4)
        except Exception:
            return None

    def _bollinger(self, close: pd.Series, window: int = 20, num_std: float = 2.0) -> Tuple[Optional[float], Optional[float]]:
        """Return (position, width). Position: 0=lower band, 0.5=middle, 1=upper band."""
        try:
            ma = close.rolling(window).mean()
            sd = close.rolling(window).std()
            upper = ma + num_std * sd
            lower = ma - num_std * sd
            c = close.iloc[-1]
            u = upper.iloc[-1]
            l = lower.iloc[-1]
            m = ma.iloc[-1]
            width = (u - l) / m if m > 0 else None
            if u > l:
                pos = (c - l) / (u - l)
            else:
                pos = 0.5
            return (
                round(float(pos), 4),
                round(float(width), 6) if width is not None else None,
            )
        except Exception:
            return None, None

    def _adx(self, high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> Optional[float]:
        """Average Directional Index (trend strength 0-100)."""
        try:
            plus_dm = high.diff()
            minus_dm = -low.diff()
            plus_dm[plus_dm < 0] = 0
            minus_dm[minus_dm < 0] = 0
            # Zero out whichever is smaller
            mask = plus_dm > minus_dm
            minus_dm[mask] = 0
            plus_dm[~mask] = 0

            tr = pd.concat([
                high - low,
                (high - close.shift()).abs(),
                (low - close.shift()).abs(),
            ], axis=1).max(axis=1)

            atr = tr.ewm(alpha=1/period, adjust=False, min_periods=period).mean()
            plus_di = 100 * plus_dm.ewm(alpha=1/period, adjust=False, min_periods=period).mean() / atr
            minus_di = 100 * minus_dm.ewm(alpha=1/period, adjust=False, min_periods=period).mean() / atr
            dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
            adx = dx.ewm(alpha=1/period, adjust=False, min_periods=period).mean()
            v = adx.iloc[-1]
            if math.isnan(v):
                return None
            return round(float(v), 4)
        except Exception:
            return None

    # ------------------------------------------------------------------
    # Regime detection (GMM, lightweight HMM alternative)
    # ------------------------------------------------------------------

    def _detect_regime(self, df: pd.DataFrame) -> Tuple[str, float]:
        """
        Classify market regime using GaussianMixture on [returns, volatility, trend].
        Returns (regime_label, confidence).
        """
        try:
            from sklearn.mixture import GaussianMixture
        except ImportError:
            logger.warning("sklearn not available - using fallback regime detection")
            return self._fallback_regime(df)

        try:
            close = df["close"]
            returns = close.pct_change().dropna()

            if len(returns) < 30:
                return self._fallback_regime(df)

            features = pd.DataFrame({
                "ret": returns,
                "vol5": returns.rolling(5).std(),
                "trend10": returns.rolling(10).mean(),
            }).dropna()

            if len(features) < 30:
                return self._fallback_regime(df)

            X = features.values

            gmm = GaussianMixture(n_components=4, covariance_type="full", random_state=42, max_iter=200)
            gmm.fit(X)

            latest = X[-1:].reshape(1, -1)
            probs = gmm.predict_proba(latest)[0]
            label_idx = int(gmm.predict(latest)[0])
            confidence = float(probs[label_idx])

            means = gmm.means_
            component_regimes = []
            for i in range(4):
                mean_vol = means[i][1]
                mean_trend = means[i][2]

                if mean_vol > np.median(means[:, 1]) * 1.3:
                    component_regimes.append("volatile")
                elif mean_trend > 0.001:
                    component_regimes.append("trending_up")
                elif mean_trend < -0.001:
                    component_regimes.append("trending_down")
                else:
                    component_regimes.append("sideways")

            regime = component_regimes[label_idx]
            logger.info(f"Regime detected: {regime} (confidence={confidence:.2%})")
            return regime, confidence

        except Exception as e:
            logger.warning(f"GMM regime detection failed: {e} - using fallback")
            return self._fallback_regime(df)

    def _fallback_regime(self, df: pd.DataFrame) -> Tuple[str, float]:
        """Simple rule-based regime fallback."""
        try:
            close = df["close"]
            returns = close.pct_change().dropna()
            if len(returns) < 20:
                return "sideways", 0.5

            recent_ret = returns.iloc[-20:]
            mean_ret = recent_ret.mean()
            vol = recent_ret.std()
            trend = close.iloc[-1] / close.iloc[-20] - 1 if len(close) >= 20 else 0

            if vol > 0.025:
                return "volatile", 0.6
            if trend > 0.05 and mean_ret > 0:
                return "trending_up", 0.6
            if trend < -0.05 and mean_ret < 0:
                return "trending_down", 0.6
            return "sideways", 0.5
        except Exception:
            return "sideways", 0.3
