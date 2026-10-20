"""
Portfolio Optimizer - Riskfolio-Lib based position sizing.

Provides PositionSizer which computes optimal portfolio weights under three
models (Risk Parity, Black-Litterman, Mean-Variance) and validates proposed
trades against concentration limits.

Regime-aware strategy selection:
  - defensive  (volatile / trending_down): Risk Parity with bond tilt
  - aggressive (trending_up):              Black-Litterman with growth view
  - neutral    (sideways / unknown):       pure Risk Parity
"""

import logging
import time
from typing import Dict, Any, List, Optional, Tuple

import numpy as np
import pandas as pd

from alpha_engine import AlphaEngine
from attribution_analyzer import AttributionAnalyzer

logger = logging.getLogger(__name__)

try:
    import riskfolio as rp
    _RISKfolio_OK = True
except Exception as _e:
    logger.warning(f"riskfolio-lib unavailable: {_e}")
    rp = None
    _RISKfolio_OK = False

# Concentration / sizing limits
MAX_SINGLE_WEIGHT = 0.30       # hard cap per symbol
MIN_WEIGHT_FLOOR = 0.0
DEFAULT_TARGET_WEIGHT = 0.20   # fallback equal-ish target
BOND_PROXY = "BOND"            # synthetic low-vol asset label for bond tilt

# Regime mapping from Alpha Engine labels to strategy buckets
_REGIME_TO_STRATEGY = {
    "volatile": "defensive",
    "trending_down": "defensive",
    "trending_up": "aggressive",
    "sideways": "neutral",
}


class PositionSizer:
    """Computes optimal portfolio weights and validates position limits."""

    _price_cache: Dict[str, Tuple[pd.DataFrame, float]] = {}
    PRICE_CACHE_TTL = 300

    def __init__(self, max_single_weight: float = MAX_SINGLE_WEIGHT,
                 attribution_analyzer: Optional["AttributionAnalyzer"] = None):
        self.max_single_weight = max_single_weight
        self._engine = AlphaEngine()
        self._attribution = attribution_analyzer
        logger.info(f"PositionSizer initialized (riskfolio={'ok' if _RISKfolio_OK else 'MISSING'}, max_w={max_single_weight}, attribution={'ok' if attribution_analyzer else 'none'})")

    def set_attribution_analyzer(self, analyzer: "AttributionAnalyzer"):
        """Late-bind the attribution analyzer (shared singleton from main)."""
        self._attribution = analyzer

    # ------------------------------------------------------------------
    # Data
    # ------------------------------------------------------------------

    def _get_history(self, symbol: str) -> Optional[pd.DataFrame]:
        now = time.time()
        cached = self._price_cache.get(symbol)
        if cached and (now - cached[1]) < self.PRICE_CACHE_TTL:
            return cached[0]
        df = self._engine._fetch_ohlcv(symbol, range_param="1y")
        if df is not None:
            self._price_cache[symbol] = (df, now)
        return df

    def _build_returns(self, symbols: List[str]) -> Tuple[pd.DataFrame, List[str]]:
        """Build aligned daily returns frame; returns (returns_df, usable_symbols).

        Uses outer join then per-symbol ffill so markets with different trading
        calendars (KR vs US) don't collapse the intersection to zero rows.
        """
        series = {}
        for sym in symbols:
            df = self._get_history(sym)
            if df is None or len(df) < 40:
                continue
            r = df["close"].pct_change().dropna()
            series[sym] = r
        if not series:
            return pd.DataFrame(), []
        rets = pd.DataFrame(series)  # outer join on dates
        rets = rets.sort_index().ffill()
        # Drop rows where ALL are NaN (leading warm-up), then any column still
        # too sparse is excluded.
        rets = rets.dropna(how="all")
        min_obs = max(30, int(len(rets) * 0.5))
        usable = [c for c in rets.columns if rets[c].notna().sum() >= min_obs]
        if not usable:
            return pd.DataFrame(), []
        rets = rets[usable].ffill().dropna()
        return rets, usable

    # ------------------------------------------------------------------
    # Regime
    # ------------------------------------------------------------------

    def _resolve_strategy(self, macro_regime: Optional[str]) -> Dict[str, Any]:
        """Map Alpha Engine regime label -> strategy bucket + model."""
        reg = (macro_regime or "neutral").lower()
        strategy = _REGIME_TO_STRATEGY.get(reg, "neutral")
        if strategy == "defensive":
            return {"strategy": strategy, "model": "RP", "bond_tilt": True, "view": None}
        if strategy == "aggressive":
            return {"strategy": strategy, "model": "BL", "bond_tilt": False, "view": "growth"}
        return {"strategy": "neutral", "model": "RP", "bond_tilt": False, "view": None}

    # ------------------------------------------------------------------
    # Core optimization
    # ------------------------------------------------------------------

    def _optimize(self, rets: pd.DataFrame, plan: Dict[str, Any]) -> Optional[pd.Series]:
        """Run riskfolio optimization, return weight Series (index=symbol)."""
        if not _RISKfolio_OK or rets.empty:
            return None
        model = plan["model"]
        try:
            if model == "RP":
                port = rp.Portfolio(returns=rets)
                port.assets_stats(method_mu="hist", method_cov="hist")
                w = port.rp_optimization(model="Classic", rm="MV", rf=0, b=None, hist=True)
            elif model == "BL":
                port = rp.Portfolio(returns=rets)
                port.assets_stats(method_mu="hist", method_cov="hist")
                if plan.get("view") == "growth":
                    # Growth view: top-half historical performers beat bottom-half by ~2%/yr
                    hist_mu = rets.mean() * 252
                    order = hist_mu.sort_values(ascending=False)
                    n = len(order)
                    half = max(1, n // 2)
                    cols = list(rets.columns)
                    prow = {c: 0.0 for c in cols}
                    for col in order.index[:half]:
                        prow[col] = 1.0 / half
                    for col in order.index[half:]:
                        prow[col] = -1.0 / max(1, n - half)
                    P = pd.DataFrame([prow], columns=cols)
                    Q = pd.DataFrame([[0.02]])
                    port.blacklitterman_stats(P=P, Q=Q, rf=0, w=None)
                    w = port.optimization(model="BL", rm="MV", obj="Sharpe", rf=0, l=0, hist=True)
                else:
                    w = port.optimization(model="Classic", rm="MV", obj="Sharpe", rf=0, l=0, hist=True)
            else:  # MV (Mean-Variance)
                port = rp.Portfolio(returns=rets)
                port.assets_stats(method_mu="hist", method_cov="hist")
                w = port.optimization(model="Classic", rm="MV", obj="Sharpe", rf=0, l=0, hist=True)

            if w is None:
                return None
            ws = w.iloc[:, 0] if isinstance(w, pd.DataFrame) else w
            ws = ws.astype(float)
            return ws
        except Exception as e:
            logger.error(f"optimize({model}) failed: {e}", exc_info=True)
            return None

    def _apply_bond_tilt(self, weights: pd.Series, tilt: float = 0.30) -> pd.Series:
        """Blend `tilt` fraction into a synthetic low-risk sleeve, scaling equities down."""
        if tilt <= 0:
            return weights
        scaled = weights * (1.0 - tilt)
        scaled[BOND_PROXY] = tilt
        return scaled

    def _equal_weights(self, symbols: List[str], plan: Dict[str, Any]) -> pd.Series:
        n = len(symbols)
        w = pd.Series({s: 1.0 / n for s in symbols}) if n > 0 else pd.Series(dtype=float)
        if plan.get("bond_tilt") and n > 0:
            w = self._apply_bond_tilt(w)
        return w

    # ------------------------------------------------------------------
    # Public: calculate_weights
    # ------------------------------------------------------------------

    def calculate_weights(
        self,
        holdings: List[Dict[str, Any]],
        macro_regime: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Compute optimal weights for the held universe.

        holdings: [{"symbol":..., "weight":..., "pnl":...}, ...]
        Returns {strategy, model, regime, weights:{symbol:w}, method, n_assets}.
        """
        plan = self._resolve_strategy(macro_regime)
        symbols = [str(h.get("symbol", "")).strip() for h in holdings if h.get("symbol")]
        symbols = [s for s in symbols if s]
        if not symbols:
            return {"error": "no symbols", "weights": {}, "strategy": plan["strategy"], "model": plan["model"], "regime": macro_regime}

        rets, usable = self._build_returns(symbols)
        method = "riskfolio"
        if len(usable) < 2 or rets.empty:
            weights = self._equal_weights(usable if usable else symbols, plan)
            method = "equal_weight_fallback"
        else:
            w = self._optimize(rets, plan)
            if w is None:
                weights = self._equal_weights(usable, plan)
                method = "equal_weight_fallback"
            else:
                w = w.reindex(usable).fillna(0.0)
                w = w.clip(lower=MIN_WEIGHT_FLOOR)
                if plan.get("bond_tilt"):
                    w = self._apply_bond_tilt(w)
                tot = float(w.sum())
                weights = (w / tot) if tot > 0 else self._equal_weights(usable, plan)

        # --- Attribution-based Sharpe tilt (R-3 integration) ---
        adjustments = []
        if self._attribution is not None:
            base = {k: float(v) for k, v in weights.items()}
            adj_res = self._attribution.adjust_weights(base, max_single_weight=self.max_single_weight)
            weights = pd.Series(adj_res["weights"]) if len(adj_res["weights"]) else weights
            adjustments = adj_res["adjustments"]
            for a in adjustments:
                logger.info(
                    f"[portfolio] Adjusted weight for {a['symbol']}: "
                    f"{a['old']*100:.1f}% -> {a['new']*100:.1f}% (Sharpe: {a['sharpe']})"
                )

        return {
            "strategy": plan["strategy"],
            "model": plan["model"],
            "regime": macro_regime or "neutral",
            "weights": {k: round(float(v), 6) for k, v in weights.items()},
            "method": method,
            "attribution_adjusted": len(adjustments) > 0,
            "adjustments": adjustments,
            "n_assets": len(usable) if usable else len(symbols),
        }

    # ------------------------------------------------------------------
    # Public: position_limit
    # ------------------------------------------------------------------

    def position_limit(
        self,
        symbol: str,
        action: str,
        current_weight: float,
        suggested_weight: Optional[float],
    ) -> Dict[str, Any]:
        """
        Validate a proposed trade against concentration limits.
        Returns {approved, reason, suggested_weight, current_weight, max_allowed}.
        """
        sym = str(symbol).upper()
        act = (action or "").upper()
        cw = float(current_weight or 0.0)
        sw = suggested_weight

        if act in ("SELL", "REDUCE"):
            return {
                "approved": True,
                "reason": "reduce/exit always allowed",
                "suggested_weight": sw if sw is not None else cw,
                "current_weight": cw,
                "max_allowed": self.max_single_weight,
            }

        # BUY / ADD: would the resulting weight breach the cap?
        target = sw if sw is not None else DEFAULT_TARGET_WEIGHT
        resulting = max(cw, target)
        if resulting > self.max_single_weight:
            capped = min(target, self.max_single_weight)
            # If already at/over cap, block entirely
            if cw >= self.max_single_weight:
                return {
                    "approved": False,
                    "reason": f"concentration cap: {sym} already at {cw:.1%} >= {self.max_single_weight:.0%} max",
                    "suggested_weight": cw,
                    "current_weight": cw,
                    "max_allowed": self.max_single_weight,
                }
            return {
                "approved": True,
                "reason": f"capped to {self.max_single_weight:.0%} limit (requested {target:.1%})",
                "suggested_weight": round(capped, 6),
                "current_weight": cw,
                "max_allowed": self.max_single_weight,
            }

        return {
            "approved": True,
            "reason": "within limits",
            "suggested_weight": round(min(target, self.max_single_weight), 6),
            "current_weight": cw,
            "max_allowed": self.max_single_weight,
        }

    # ------------------------------------------------------------------
    # Public: evaluate_position (one-call combo for the API)
    # ------------------------------------------------------------------

    def evaluate_position(
        self,
        symbol: str,
        action: str,
        current_portfolio: List[Dict[str, Any]],
        macro_regime: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Full sizing decision for one proposed trade:
          1. Build universe = portfolio symbols + target symbol
          2. Compute optimal weights under regime-appropriate model
          3. Validate against concentration cap
        Returns {approved, reason, suggested_weight, model, strategy, regime,
                 current_weight, optimal_weights, method}.
        """
        sym = str(symbol).upper()
        universe = list(current_portfolio or [])
        if not any(str(h.get("symbol", "")).upper() == sym for h in universe):
            universe.append({"symbol": sym, "weight": 0.0, "pnl": 0.0})

        # current weight of the target symbol
        cur_w = 0.0
        for h in universe:
            if str(h.get("symbol", "")).upper() == sym:
                try:
                    cur_w = float(h.get("weight", 0.0) or 0.0)
                except Exception:
                    cur_w = 0.0

        wres = self.calculate_weights(universe, macro_regime=macro_regime)
        opt_w = wres.get("weights", {}).get(sym)
        # BOND sleeve is not tradeable; treat as None
        suggested = opt_w

        lim = self.position_limit(sym, action, cur_w, suggested)
        return {
            "approved": lim["approved"],
            "reason": lim["reason"],
            "suggested_weight": lim["suggested_weight"],
            "current_weight": cur_w,
            "optimal_weight": suggested,
            "max_allowed": self.max_single_weight,
            "model": wres.get("model"),
            "strategy": wres.get("strategy"),
            "regime": wres.get("regime"),
            "optimal_weights": wres.get("weights"),
            "method": wres.get("method"),
            "n_assets": wres.get("n_assets"),
        }


    def rebalance_plan(self, current_portfolio: Dict[str, Any], macro_regime: Optional[str] = None) -> Dict[str, Any]:
        """Generate rebalance plan: compare current vs target weights, return trades needed.
        
        Args:
            current_portfolio: {positions: [{symbol, quantity, currentPrice, marketValue, weight}], cashKrw}
            macro_regime: optional regime override
            
        Returns:
            {trades: [{symbol, action, target_weight, current_weight, delta_value_krw, reason}], ...}
        """
        positions = current_portfolio.get("positions", [])
        cash_krw = current_portfolio.get("cashKrw", 0)
        
        if not positions:
            return {"trades": [], "reason": "no positions to rebalance", "cash_krw": cash_krw}
        
        # Calculate current total equity
        invested = sum(p.get("marketValue", 0) for p in positions)
        total_equity = invested + cash_krw
        
        if total_equity <= 0:
            return {"trades": [], "reason": "zero equity", "cash_krw": cash_krw}
        
        # Get target weights from portfolio optimizer
        symbols = [p["symbol"] for p in positions if p.get("symbol")]
        if not symbols:
            return {"trades": [], "reason": "no valid symbols in positions", "cash_krw": cash_krw}
        
        try:
            target_weights = self.calculate_weights(symbols, macro_regime)
            if not isinstance(target_weights, dict):
                raise ValueError(f"calculate_weights returned {type(target_weights)}, expected dict")
        except Exception as e:
            logger.warning(f"Failed to calculate target weights: {e}")
            # Fallback: equal weight
            target_weights = {s: 1.0 / len(symbols) for s in symbols}
        
        # Build current weight map
        current_weights = {}
        for p in positions:
            sym = p.get("symbol")
            if sym:
                current_weights[sym] = p.get("weight", (p.get("marketValue", 0) / total_equity))
        
        # Calculate trades needed
        trades = []
        rebalance_threshold = 0.05  # 5% deviation triggers rebalance
        
        for sym in set(list(target_weights.keys()) + list(current_weights.keys())):
            target_w = target_weights.get(sym, 0.0)
            current_w = current_weights.get(sym, 0.0)
            delta_w = target_w - current_w
            
            # Skip if within threshold
            if abs(delta_w) < rebalance_threshold:
                continue
            
            delta_value = delta_w * total_equity
            
            if delta_w > 0:
                # Need to BUY more
                trades.append({
                    "symbol": sym,
                    "action": "BUY",
                    "target_weight": target_w,
                    "current_weight": current_w,
                    "delta_weight": delta_w,
                    "delta_value_krw": delta_value,
                    "reason": f"underweight by {delta_w*100:.1f}%",
                })
            else:
                # Need to SELL
                trades.append({
                    "symbol": sym,
                    "action": "SELL",
                    "target_weight": target_w,
                    "current_weight": current_w,
                    "delta_weight": delta_w,
                    "delta_value_krw": delta_value,
                    "reason": f"overweight by {abs(delta_w)*100:.1f}%",
                })
        
        # Sort: SELL first (to free cash), then BUY
        trades.sort(key=lambda t: (0 if t["action"] == "SELL" else 1, -abs(t["delta_value_krw"])))
        
        return {
            "trades": trades,
            "total_equity_krw": total_equity,
            "cash_krw": cash_krw,
            "invested_krw": invested,
            "target_weights": target_weights,
            "current_weights": current_weights,
            "macro_regime": macro_regime or "neutral",
            "rebalance_threshold": rebalance_threshold,
        }

