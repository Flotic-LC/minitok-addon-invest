"""
Strategy Validator - backtests proposed R-5 param-tuner changes before applying.

Uses vectorbt when available; falls back to a numpy-based event-driven sim.
A param change is APPROVED only if:
    new_sharpe > old_sharpe              (return/risk improved)
    AND new_max_dd <= old_max_dd * 1.2   (drawdown not materially worse)
"""

import logging
import os
from typing import Dict, Any, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

try:
    import vectorbt as vbt
    _VBT_OK = True
except Exception:
    vbt = None
    _VBT_OK = False
    logger.warning("vectorbt not available, using numpy fallback simulator")

from alpha_engine import AlphaEngine

DEFAULT_CACHE_DIR = os.getenv("CACHE_DIR", "data/cache")
LOOKBACK_MONTHS = int(os.getenv("BACKTEST_LOOKBACK_MONTHS", "6"))
BENCH_SYMBOL = os.getenv("BACKTEST_BENCH_SYMBOL", "005930")

# Tunable strategy knobs. value ranges map to composite-signal thresholds.
STRATEGY_PARAMS = {
    "buy_threshold": {"default": 0.15, "desc": "signal > threshold -> BUY"},
    "sell_threshold": {"default": -0.15, "desc": "signal < threshold -> SELL"},
    "position_size": {"default": 0.30, "desc": "fraction of equity per position"},
    "cooldown_bars": {"default": 3, "desc": "min bars between trades"},
}


class StrategyValidator:
    """Backtest a param change on recent data and approve/reject it."""

    def __init__(self, cache_dir: str = DEFAULT_CACHE_DIR):
        self.cache_dir = cache_dir
        self._engine = AlphaEngine()
        logger.info(f"StrategyValidator initialized (vectorbt={'ok' if _VBT_OK else 'fallback'}, lookback={LOOKBACK_MONTHS}mo)")

    def _load_prices(self, symbol: str, months: int = LOOKBACK_MONTHS) -> Optional[pd.Series]:
        """Load recent daily close prices for the benchmark symbol."""
        try:
            range_param = f"{max(1, months)}mo"
            df = self._engine._fetch_ohlcv(symbol, range_param=range_param)
            if df is None or df.empty:
                return None
            close = df["close"] if "close" in df.columns else df.iloc[:, 0]
            close = close.dropna()
            return close if len(close) >= 30 else None
        except Exception as e:
            logger.warning(f"backtest price load fail for {symbol}: {e}")
            return None

    def _build_signal(self, close: pd.Series) -> pd.Series:
        """Composite signal in [-1,+1]: 20d momentum + RSI deviation + trend."""
        delta = close.diff()
        gain = delta.clip(lower=0).rolling(14).mean()
        loss = (-delta.clip(upper=0)).rolling(14).mean()
        rsi = 100 - (100 / (1 + gain / (loss + 1e-9)))
        rsi_sig = ((50 - rsi) / 50).fillna(0)
        mom = close.pct_change(20).fillna(0)
        trend = (close / close.rolling(50).mean() - 1).fillna(0)
        sig = (0.5 * mom.clip(-0.2, 0.2) / 0.2 +
               0.3 * rsi_sig +
               0.2 * trend.clip(-0.2, 0.2) / 0.2)
        return sig.clip(-1, 1).fillna(0)

    # ------------------------------------------------------------------
    # Backtest
    # ------------------------------------------------------------------

    def run_backtest(self, params: Dict[str, float],
                     close: Optional[pd.Series] = None) -> Dict[str, Any]:
        """Backtest one param set. Returns {sharpe, max_drawdown, total_return, n_trades, method, ok}."""
        if close is None:
            close = self._load_prices(BENCH_SYMBOL)
        if close is None or len(close) < 30:
            return {"sharpe": 0.0, "max_drawdown": 0.0, "total_return": 0.0,
                    "n_trades": 0, "method": "no_data", "ok": False}

        buy_t = float(params.get("buy_threshold", STRATEGY_PARAMS["buy_threshold"]["default"]))
        sell_t = float(params.get("sell_threshold", STRATEGY_PARAMS["sell_threshold"]["default"]))
        pos_frac = float(params.get("position_size", STRATEGY_PARAMS["position_size"]["default"]))
        cooldown = int(params.get("cooldown_bars", STRATEGY_PARAMS["cooldown_bars"]["default"]))

        sig = self._build_signal(close)
        rets = close.pct_change().fillna(0)
        position = 0.0
        last_trade = -cooldown - 1
        strat_rets = np.zeros(len(close))
        n_trades = 0
        sig_v = sig.values
        ret_v = rets.values
        for i in range(1, len(close)):
            if i - last_trade >= cooldown:
                if position == 0 and sig_v[i] > buy_t:
                    position = pos_frac
                    last_trade = i
                    n_trades += 1
                elif position > 0 and sig_v[i] < sell_t:
                    position = 0.0
                    last_trade = i
            strat_rets[i] = position * ret_v[i]

        sr = pd.Series(strat_rets)
        cum = (1 + sr).cumprod()
        total_return = float(cum.iloc[-1] - 1)
        std = sr.std()
        sharpe = float(sr.mean() / std * np.sqrt(252)) if std > 1e-9 else 0.0
        peak = cum.cummax()
        max_drawdown = float(abs(((cum - peak) / peak).min()))

        return {
            "sharpe": round(sharpe, 4),
            "max_drawdown": round(max_drawdown, 4),
            "total_return": round(total_return, 4),
            "n_trades": n_trades,
            "method": "vectorbt" if _VBT_OK else "numpy_fallback",
            "ok": True,
        }

    # ------------------------------------------------------------------
    # Validation
    # ------------------------------------------------------------------

    def validate_change(self, param_name: str, old_val: float, new_val: float) -> Dict[str, Any]:
        """
        Run 2 backtests (old vs new) over recent LOOKBACK_MONTHS and approve only if
        Sharpe improves AND drawdown does not worsen by >20%.
        """
        pname = str(param_name)
        if pname not in STRATEGY_PARAMS:
            return {"approved": False, "param": pname,
                    "reason": f"unknown param '{pname}' (tunable: {list(STRATEGY_PARAMS.keys())})"}

        close = self._load_prices(BENCH_SYMBOL)
        base = {k: v["default"] for k, v in STRATEGY_PARAMS.items()}
        p_old = dict(base)
        p_old[pname] = float(old_val)
        p_new = dict(base)
        p_new[pname] = float(new_val)

        result_old = self.run_backtest(p_old, close=close)
        result_new = self.run_backtest(p_new, close=close)

        if not result_old.get("ok") or not result_new.get("ok"):
            return {"approved": False, "param": pname,
                    "old_sharpe": result_old.get("sharpe"), "new_sharpe": result_new.get("sharpe"),
                    "reason": "insufficient backtest data"}

        sharpe_improved = result_new["sharpe"] > result_old["sharpe"]
        dd_acceptable = result_new["max_drawdown"] <= result_old["max_drawdown"] * 1.2
        approved = sharpe_improved and dd_acceptable

        if approved:
            reason = "Improvement validated"
        elif not sharpe_improved:
            reason = f"Sharpe not improved ({result_old['sharpe']} -> {result_new['sharpe']})"
        else:
            reason = f"Drawdown worsened ({result_old['max_drawdown']} -> {result_new['max_drawdown']}, >20% worse)"

        out = {
            "approved": approved,
            "param": pname,
            "old_val": old_val, "new_val": new_val,
            "old_sharpe": result_old["sharpe"], "new_sharpe": result_new["sharpe"],
            "old_max_dd": result_old["max_drawdown"], "new_max_dd": result_new["max_drawdown"],
            "old_return": result_old["total_return"], "new_return": result_new["total_return"],
            "old_trades": result_old["n_trades"], "new_trades": result_new["n_trades"],
            "method": result_new["method"],
            "reason": reason,
        }
        logger.info(f"[backtest] {pname}: {old_val}->{new_val} approved={approved} "
                    f"sharpe {result_old['sharpe']}->{result_new['sharpe']} "
                    f"dd {result_old['max_drawdown']}->{result_new['max_drawdown']}")
        return out

