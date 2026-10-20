"""
Alpha Validator - factor predictive power backtesting.

Computes per-factor Information Coefficient (IC) and Information Ratio (IR):
  - IC:  Spearman rank correlation between factor value at day t
         and forward return over the next `horizon` days.
  - IR:  mean(IC series) / std(IC series).

Also provides cross-factor correlation matrix for multicollinearity checks
and a convenience validator that scores every factor across a symbol universe.
"""

import logging
import time
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats

from alpha_engine import AlphaEngine

logger = logging.getLogger(__name__)

FACTOR_NAMES = [
    "momentum_5d", "momentum_20d", "momentum_60d",
    "volatility_20d", "volatility_60d", "volatility_ratio",
    "volume_price_corr", "volume_ratio_20d", "volume_momentum",
    "macd", "macd_signal", "macd_histogram",
    "rsi_14", "rsi_7",
    "bollinger_position", "bollinger_width",
    "trend_strength",
    "price_position_52w", "distance_from_high_20d",
    "ma_cross_5_20", "ma_cross_20_60",
]

IC_WEAK = 0.02
IC_GOOD = 0.05
IR_ACCEPTABLE = 0.5


class AlphaValidator:
    """Validates factor predictive power using historical OHLCV data."""

    _price_cache: Dict[str, Tuple[pd.DataFrame, float]] = {}
    PRICE_CACHE_TTL = 300

    def __init__(self):
        self._engine = AlphaEngine()
        logger.info("AlphaValidator initialized")

    def _get_history(self, symbol: str) -> Optional[pd.DataFrame]:
        """Fetch 1y OHLCV with 5-min in-memory cache."""
        now = time.time()
        cached = self._price_cache.get(symbol)
        if cached and (now - cached[1]) < self.PRICE_CACHE_TTL:
            return cached[0]
        df = self._engine._fetch_ohlcv(symbol, range_param="1y")
        if df is not None:
            self._price_cache[symbol] = (df, now)
        return df

    # ------------------------------------------------------------------
    # Factor series (historical point-in-time values)
    # ------------------------------------------------------------------

    def compute_factor_series(self, df: pd.DataFrame, factor_name: str) -> pd.Series:
        """Point-in-time daily series of a single factor."""
        close = df["close"]
        high = df["high"]
        low = df["low"]
        volume = df["volume"]

        if factor_name == "momentum_5d":
            return close / close.shift(5) - 1
        if factor_name == "momentum_20d":
            return close / close.rolling(20).mean() - 1
        if factor_name == "momentum_60d":
            return close / close.rolling(60).mean() - 1

        if factor_name == "volatility_20d":
            return close.rolling(20).std() / close.rolling(20).mean()
        if factor_name == "volatility_60d":
            return close.rolling(60).std() / close.rolling(60).mean()
        if factor_name == "volatility_ratio":
            return close.rolling(5).std() / close.rolling(20).std()

        if factor_name == "volume_price_corr":
            return close.rolling(10).corr(volume)
        if factor_name == "volume_ratio_20d":
            return volume / volume.rolling(20).mean()
        if factor_name == "volume_momentum":
            return volume.rolling(5).mean() / volume.rolling(20).mean()

        if factor_name in ("macd", "macd_signal", "macd_histogram"):
            ema_fast = close.ewm(span=12, adjust=False).mean()
            ema_slow = close.ewm(span=26, adjust=False).mean()
            macd_line = ema_fast - ema_slow
            signal_line = macd_line.ewm(span=9, adjust=False).mean()
            # Normalize by price for cross-sectional comparability
            if factor_name == "macd":
                return macd_line / close
            if factor_name == "macd_signal":
                return signal_line / close
            return (macd_line - signal_line) / close

        if factor_name in ("rsi_14", "rsi_7"):
            period = 14 if factor_name == "rsi_14" else 7
            delta = close.diff()
            gain = delta.clip(lower=0)
            loss = -delta.clip(upper=0)
            avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
            avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
            rs = avg_gain / avg_loss
            return 100 - (100 / (1 + rs))

        if factor_name in ("bollinger_position", "bollinger_width"):
            ma = close.rolling(20).mean()
            sd = close.rolling(20).std()
            upper = ma + 2 * sd
            lower = ma - 2 * sd
            if factor_name == "bollinger_position":
                return (close - lower) / (upper - lower)
            return (upper - lower) / ma

        if factor_name == "trend_strength":
            return self._adx_series(high, low, close, 14)

        if factor_name == "price_position_52w":
            hi = close.rolling(252, min_periods=60).max()
            lo = close.rolling(252, min_periods=60).min()
            return (close - lo) / (hi - lo)
        if factor_name == "distance_from_high_20d":
            return (close - close.rolling(20).max()) / close.rolling(20).max()

        if factor_name == "ma_cross_5_20":
            return close.rolling(5).mean() / close.rolling(20).mean() - 1
        if factor_name == "ma_cross_20_60":
            return close.rolling(20).mean() / close.rolling(60).mean() - 1

        raise ValueError(f"Unknown factor: {factor_name}")

    def _adx_series(self, high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
        plus_dm = high.diff().clip(lower=0)
        minus_dm = (-low.diff()).clip(lower=0)
        mask = plus_dm > minus_dm
        minus_dm = minus_dm.where(mask, 0)
        plus_dm = plus_dm.where(~mask, 0)
        tr = pd.concat([
            high - low,
            (high - close.shift()).abs(),
            (low - close.shift()).abs(),
        ], axis=1).max(axis=1)
        atr = tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
        plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr
        minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / atr
        dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di)
        return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()

    # ------------------------------------------------------------------
    # IC / IR
    # ------------------------------------------------------------------

    def _forward_returns(self, close: pd.Series, horizon: int) -> pd.Series:
        """Forward return over `horizon` days: close[t+h] / close[t] - 1."""
        return close.shift(-horizon) / close - 1

    def calculate_ic(
        self,
        symbol: str,
        factor_name: str,
        lookback_days: int = 252,
        horizon: int = 1,
        rolling_window: int = 20,
    ) -> Dict[str, Any]:
        """
        IC = Spearman rank corr(factor[t], forward_return[t, t+horizon]).

        Returns dict with:
          ic_mean, ic_std, ic_series_tail (last 10 rolling ICs),
          n_obs, p_value (Spearman overall), direction, significant.
        """
        df = self._get_history(symbol)
        if df is None or len(df) < 60:
            raise ValueError(f"Insufficient history for {symbol}")

        factor = self.compute_factor_series(df, factor_name)
        fwd = self._forward_returns(df["close"], horizon)

        paired = pd.DataFrame({"f": factor, "r": fwd}).dropna()
        paired = paired.tail(lookback_days)
        if len(paired) < 30:
            raise ValueError(f"Insufficient paired observations: {len(paired)}")

        # Overall Spearman IC + p-value
        ic_overall, p_value = scipy_stats.spearmanr(paired["f"], paired["r"])

        # Rolling IC series for IR (manual rolling Spearman - pandas rolling.corr
        # lacks method= kwarg on some versions)
        fv = paired["f"].values
        rv = paired["r"].values
        ic_vals: List[float] = []
        for i in range(rolling_window - 1, len(fv)):
            rho, _ = scipy_stats.spearmanr(
                fv[i - rolling_window + 1: i + 1],
                rv[i - rolling_window + 1: i + 1],
            )
            if not np.isnan(rho):
                ic_vals.append(float(rho))
        ic_series = pd.Series(ic_vals)
        ic_mean = float(ic_series.mean()) if len(ic_series) > 0 else float("nan")
        ic_std = float(ic_series.std()) if len(ic_series) > 1 else float("nan")
        ir = ic_mean / ic_std if ic_std and not np.isnan(ic_std) and ic_std > 0 else None

        tail = [round(float(x), 4) for x in ic_series.tail(10).tolist()]

        direction = "positive" if ic_overall > 0 else ("negative" if ic_overall < 0 else "neutral")
        return {
            "symbol": symbol,
            "factor": factor_name,
            "horizon_days": horizon,
            "lookback_days": lookback_days,
            "n_obs": int(len(paired)),
            "ic": round(float(ic_overall), 4) if not np.isnan(ic_overall) else None,
            "ic_mean_rolling": round(ic_mean, 4) if not np.isnan(ic_mean) else None,
            "ic_std_rolling": round(ic_std, 4) if not np.isnan(ic_std) else None,
            "ir": round(ir, 4) if ir is not None else None,
            "p_value": round(float(p_value), 6) if not np.isnan(p_value) else None,
            "significant": bool(p_value < 0.05) if not np.isnan(p_value) else False,
            "direction": direction,
            "quality": self._grade(ic_overall, ir, p_value),
            "ic_series_tail": tail,
        }

    def calculate_ir(self, symbol: str, factor_name: str, **kwargs) -> Dict[str, Any]:
        """IR convenience wrapper - reuses calculate_ic result."""
        res = self.calculate_ic(symbol, factor_name, **kwargs)
        return {
            "symbol": res["symbol"],
            "factor": res["factor"],
            "ir": res["ir"],
            "ic_mean_rolling": res["ic_mean_rolling"],
            "ic_std_rolling": res["ic_std_rolling"],
            "rating": (
                "strong" if res["ir"] and res["ir"] >= IR_ACCEPTABLE
                else "acceptable" if res["ir"] and res["ir"] >= 0.2
                else "weak"
            ),
        }

    def _grade(self, ic: float, ir: Optional[float], p: float) -> str:
        if np.isnan(ic) or np.isnan(p):
            return "insufficient_data"
        aic = abs(ic)
        if p < 0.05 and aic >= IC_GOOD and ir is not None and ir >= IR_ACCEPTABLE:
            return "strong"
        if p < 0.05 and aic >= IC_GOOD:
            return "good"
        if p < 0.05 and aic >= IC_WEAK:
            return "weak_significant"
        if p < 0.05:
            return "significant_tiny"
        return "not_significant"

    # ------------------------------------------------------------------
    # Cross-factor correlation (multicollinearity)
    # ------------------------------------------------------------------

    def factor_correlation_matrix(self, symbols: List[str]) -> Dict[str, Any]:
        """
        Cross-factor Spearman correlation using TIME-SERIES of factor values
        pooled across symbols (not cross-sectional snapshot).

        For each symbol we compute all factor series over the lookback window,
        stack them, then compute pairwise factor correlations.
        Returns {factors, matrix, high_corr_pairs, n_obs}.
        """
        all_series: Dict[str, List[float]] = {f: [] for f in FACTOR_NAMES}

        for sym in symbols:
            df = self._get_history(sym)
            if df is None or len(df) < 60:
                continue
            for fname in FACTOR_NAMES:
                try:
                    s = self.compute_factor_series(df, fname)
                    all_series[fname].extend(s.tolist())
                except Exception:
                    continue

        fdf = pd.DataFrame(all_series).dropna()
        if len(fdf) < 50:
            return {"error": f"insufficient pooled observations: {len(fdf)}"}

        corr = fdf.corr(method="spearman")
        matrix = {
            f: {g: (round(float(corr.loc[f, g]), 4) if not np.isnan(corr.loc[f, g]) else None)
                for g in corr.columns}
            for f in corr.index
        }

        high_corr = []
        cols = list(corr.columns)
        for i in range(len(cols)):
            for j in range(i + 1, len(cols)):
                v = corr.iloc[i, j]
                if not np.isnan(v) and abs(v) >= 0.7:
                    high_corr.append({
                        "pair": [cols[i], cols[j]],
                        "correlation": round(float(v), 4),
                    })
        high_corr.sort(key=lambda x: -abs(x["correlation"]))

        return {
            "factors": cols,
            "matrix": matrix,
            "high_corr_pairs": high_corr,
            "n_obs": int(len(fdf)),
            "n_symbols": len(symbols),
            "method": "pooled_time_series",
        }

    # ------------------------------------------------------------------
    # Batch validation
    # ------------------------------------------------------------------

    def validate_all(
        self,
        symbols: List[str],
        horizon: int = 1,
        lookback_days: int = 252,
    ) -> Dict[str, Any]:
        """
        Score every factor across every symbol.
        Aggregates IC per factor: mean IC across symbols, % significant.
        """
        per_symbol: Dict[str, Dict[str, Any]] = {}
        factor_ics: Dict[str, List[float]] = {f: [] for f in FACTOR_NAMES}
        factor_sig: Dict[str, int] = {f: 0 for f in FACTOR_NAMES}
        factor_tot: Dict[str, int] = {f: 0 for f in FACTOR_NAMES}

        for sym in symbols:
            sym_res: Dict[str, Any] = {}
            for fname in FACTOR_NAMES:
                try:
                    r = self.calculate_ic(sym, fname, lookback_days=lookback_days, horizon=horizon)
                    sym_res[fname] = {
                        "ic": r["ic"], "ir": r["ir"],
                        "p_value": r["p_value"], "significant": r["significant"],
                    }
                    if r["ic"] is not None:
                        factor_ics[fname].append(r["ic"])
                        factor_tot[fname] += 1
                        if r["significant"]:
                            factor_sig[fname] += 1
                except Exception as e:
                    sym_res[fname] = {"error": str(e)}
            per_symbol[sym] = sym_res

        summary = []
        for fname in FACTOR_NAMES:
            ics = factor_ics[fname]
            if not ics:
                summary.append({"factor": fname, "mean_ic": None, "n_symbols": 0})
                continue
            mean_ic = float(np.mean(ics))
            pct_sig = factor_sig[fname] / factor_tot[fname] if factor_tot[fname] else 0
            summary.append({
                "factor": fname,
                "mean_ic": round(mean_ic, 4),
                "mean_abs_ic": round(float(np.mean([abs(x) for x in ics])), 4),
                "pct_significant": round(pct_sig, 4),
                "n_symbols": len(ics),
                "direction": "positive" if mean_ic > 0 else "negative",
            })
        summary.sort(key=lambda x: -(x["mean_abs_ic"] or 0))

        return {
            "summary": summary,
            "per_symbol": per_symbol,
            "horizon_days": horizon,
            "lookback_days": lookback_days,
            "n_symbols": len(symbols),
        }
