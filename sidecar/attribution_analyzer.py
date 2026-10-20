"""
Attribution Analyzer - consumes R-3 attribution fills from the trading runner
and converts them into per-symbol risk-adjusted performance (Sharpe-like ratio)
used to adjust portfolio weights.

Data flow:
  runner.js attributionEngine fills  -->  POST /api/v1/attribution/update
  -->  AttributionAnalyzer (in-memory, persisted to data/cache)
  -->  calculate_weights() applies Sharpe-based tilt
  -->  GET /api/v1/attribution/summary, /api/v1/portfolio/recommendations
"""

import logging
import math
import os
import json
import time
from typing import Dict, Any, List, Optional
from collections import defaultdict, deque

logger = logging.getLogger(__name__)

# Sharpe thresholds for weight adjustment
SHARPE_REDUCE_THRESHOLD = 0.5   # below -> reduce weight
SHARPE_BOOST_THRESHOLD = 1.5    # above -> boost weight
REDUCE_FACTOR = 0.5             # cut weight by 50%
BOOST_FACTOR = 1.2              # increase weight by 20%
MIN_FILLS_FOR_SHARPE = 3        # need at least this many fills for a stable Sharpe

DEFAULT_CACHE_DIR = os.getenv("CACHE_DIR", "data/cache")


class AttributionAnalyzer:
    """Accumulates per-symbol PnL fills and derives Sharpe ratios + weight advice."""

    def __init__(self, cache_dir: str = DEFAULT_CACHE_DIR, max_history: int = 5000):
        self.cache_dir = cache_dir
        self.max_history = max_history
        # symbol -> deque of pnl floats
        self._fills: Dict[str, deque] = defaultdict(lambda: deque(maxlen=max_history))
        # strategy -> deque of pnl floats
        self._strategy_fills: Dict[str, deque] = defaultdict(lambda: deque(maxlen=max_history))
        self._persist_path = os.path.join(cache_dir, "attribution_fills.json")
        os.makedirs(cache_dir, exist_ok=True)
        self._load()
        logger.info(f"AttributionAnalyzer initialized (cache_dir={cache_dir}, loaded={self.total_fills()} fills)")

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _load(self):
        try:
            if os.path.exists(self._persist_path):
                with open(self._persist_path) as f:
                    data = json.load(f)
                for sym, pnls in data.get("by_symbol", {}).items():
                    self._fills[sym] = deque(pnls, maxlen=self.max_history)
                for st, pnls in data.get("by_strategy", {}).items():
                    self._strategy_fills[st] = deque(pnls, maxlen=self.max_history)
        except Exception as e:
            logger.warning(f"attribution load failed: {e}")

    def _save(self):
        try:
            data = {
                "by_symbol": {s: list(d) for s, d in self._fills.items()},
                "by_strategy": {s: list(d) for s, d in self._strategy_fills.items()},
                "saved_at": time.time(),
            }
            tmp = self._persist_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(data, f)
            os.replace(tmp, self._persist_path)
        except Exception as e:
            logger.warning(f"attribution save failed: {e}")

    def total_fills(self) -> int:
        return sum(len(d) for d in self._fills.values())

    # ------------------------------------------------------------------
    # Ingestion
    # ------------------------------------------------------------------

    def record_fill(self, symbol: str, pnl: float, strategy: Optional[str] = None,
                    timestamp: Optional[float] = None) -> Dict[str, Any]:
        """Record one realized PnL fill for a symbol."""
        sym = str(symbol).upper().strip()
        if not sym:
            return {"ok": False, "reason": "no symbol"}
        try:
            p = float(pnl)
        except Exception:
            return {"ok": False, "reason": "invalid pnl"}
        self._fills[sym].append(p)
        if strategy:
            self._strategy_fills[str(strategy)].append(p)
        # Persist every 10 fills to bound IO
        if self.total_fills() % 10 == 0:
            self._save()
        return {"ok": True, "symbol": sym, "fills": len(self._fills[sym])}

    def record_report(self, report: Dict[str, Any]) -> Dict[str, Any]:
        """
        Bulk-ingest a runner attributionEngine.report() payload.
        report.bySymbol = { symbol: {pnl, count, wins, ...}, ... }
        We distribute aggregate pnl as `count` synthetic fills of pnl/count each,
        preserving mean; this is an approximation when per-fill history is unavailable.
        """
        by_symbol = (report or {}).get("bySymbol", {})
        n_ingested = 0
        for sym, agg in by_symbol.items():
            try:
                total = float(agg.get("pnl", 0.0))
                cnt = int(agg.get("count", 0))
            except Exception:
                continue
            if cnt <= 0:
                continue
            # Only ingest the delta beyond what we already recorded
            existing = len(self._fills.get(sym, []))
            delta = cnt - existing
            if delta <= 0:
                continue
            per = total / cnt if cnt else 0.0
            for _ in range(min(delta, 50)):  # cap synthetic fills
                self._fills[sym].append(per)
            n_ingested += delta
        self._save()
        return {"ok": True, "ingested": n_ingested, "total_fills": self.total_fills()}

    # ------------------------------------------------------------------
    # Sharpe
    # ------------------------------------------------------------------

    @staticmethod
    def _sharpe(pnls: List[float]) -> Optional[float]:
        """Sharpe-like ratio = mean(pnl) / stdev(pnl), scaled by sqrt(n)."""
        n = len(pnls)
        if n < MIN_FILLS_FOR_SHARPE:
            return None
        mean = sum(pnls) / n
        var = sum((x - mean) ** 2 for x in pnls) / (n - 1) if n > 1 else 0.0
        sd = math.sqrt(var)
        if sd <= 0:
            return None
        return (mean / sd) * math.sqrt(n)

    def get_symbol_sharpe(self, symbol: str, lookback_days: int = 90) -> Dict[str, Any]:
        sym = str(symbol).upper().strip()
        pnls = list(self._fills.get(sym, []))
        sharpe = self._sharpe(pnls)
        total = sum(pnls)
        wins = sum(1 for p in pnls if p > 0)
        return {
            "symbol": sym,
            "sharpe": round(sharpe, 4) if sharpe is not None else None,
            "fills": len(pnls),
            "total_pnl": round(total, 2),
            "avg_pnl": round(total / len(pnls), 2) if pnls else 0.0,
            "win_rate": round(wins / len(pnls), 4) if pnls else 0.0,
            "lookback_days": lookback_days,
            "sufficient_data": sharpe is not None,
        }

    def get_strategy_performance(self, strategy_name: str) -> Dict[str, Any]:
        pnls = list(self._strategy_fills.get(strategy_name, []))
        sharpe = self._sharpe(pnls)
        total = sum(pnls)
        return {
            "strategy": strategy_name,
            "sharpe": round(sharpe, 4) if sharpe is not None else None,
            "fills": len(pnls),
            "total_pnl": round(total, 2),
            "avg_pnl": round(total / len(pnls), 2) if pnls else 0.0,
            "sufficient_data": sharpe is not None,
        }

    def get_all_sharpes(self) -> Dict[str, float]:
        out = {}
        for sym, dq in self._fills.items():
            s = self._sharpe(list(dq))
            if s is not None:
                out[sym] = s
        return out

    # ------------------------------------------------------------------
    # Weight adjustment
    # ------------------------------------------------------------------

    def weight_multiplier(self, symbol: str) -> float:
        """Sharpe < 0.5 -> 0.5x, Sharpe > 1.5 -> 1.2x, else 1.0x."""
        sym = str(symbol).upper().strip()
        sharpe = self._sharpe(list(self._fills.get(sym, [])))
        if sharpe is None:
            return 1.0
        if sharpe < SHARPE_REDUCE_THRESHOLD:
            return REDUCE_FACTOR
        if sharpe > SHARPE_BOOST_THRESHOLD:
            return BOOST_FACTOR
        return 1.0

    def adjust_weights(self, weights: Dict[str, float],
                       max_single_weight: float = 0.30) -> Dict[str, Any]:
        """Apply Sharpe multipliers, cap, renormalize."""
        adjustments = []
        adjusted = {}
        for sym, w in weights.items():
            if sym == "BOND":
                adjusted[sym] = w
                continue
            mult = self.weight_multiplier(sym)
            sharpe = self._sharpe(list(self._fills.get(sym, [])))
            new_w = min(w * mult, max_single_weight)
            adjusted[sym] = new_w
            if abs(mult - 1.0) > 1e-9:
                adjustments.append({
                    "symbol": sym, "old": round(w, 6), "new": round(new_w, 6),
                    "sharpe": round(sharpe, 4) if sharpe is not None else None,
                    "multiplier": mult,
                })
        tot = sum(adjusted.values())
        if tot > 0:
            adjusted = {k: v / tot for k, v in adjusted.items()}
        return {"weights": {k: round(v, 6) for k, v in adjusted.items()}, "adjustments": adjustments}

    def recommend_adjustments(self) -> Dict[str, Any]:
        recs = []
        for sym, dq in self._fills.items():
            sharpe = self._sharpe(list(dq))
            if sharpe is None:
                recs.append({"symbol": sym, "sharpe": None, "action": "hold",
                             "factor": 1.0, "reason": f"insufficient data ({len(dq)} fills)"})
                continue
            if sharpe < SHARPE_REDUCE_THRESHOLD:
                recs.append({"symbol": sym, "sharpe": round(sharpe, 4), "action": "reduce",
                             "factor": REDUCE_FACTOR,
                             "reason": f"Sharpe {sharpe:.2f} < {SHARPE_REDUCE_THRESHOLD} -> cut 50%"})
            elif sharpe > SHARPE_BOOST_THRESHOLD:
                recs.append({"symbol": sym, "sharpe": round(sharpe, 4), "action": "boost",
                             "factor": BOOST_FACTOR,
                             "reason": f"Sharpe {sharpe:.2f} > {SHARPE_BOOST_THRESHOLD} -> +20% (capped)"})
            else:
                recs.append({"symbol": sym, "sharpe": round(sharpe, 4), "action": "hold",
                             "factor": 1.0, "reason": "Sharpe within neutral band"})
        recs.sort(key=lambda r: (r["sharpe"] is None, r["sharpe"] if r["sharpe"] is not None else 0))
        return {
            "recommendations": recs,
            "thresholds": {"reduce_below": SHARPE_REDUCE_THRESHOLD, "boost_above": SHARPE_BOOST_THRESHOLD},
            "reduce_factor": REDUCE_FACTOR, "boost_factor": BOOST_FACTOR,
        }

    def summary(self) -> Dict[str, Any]:
        total_pnl = sum(sum(d) for d in self._fills.values())
        symbols = []
        for sym, dq in self._fills.items():
            pnls = list(dq)
            p = sum(pnls)
            sharpe = self._sharpe(pnls)
            symbols.append({
                "symbol": sym,
                "sharpe": round(sharpe, 4) if sharpe is not None else None,
                "fills": len(pnls), "total_pnl": round(p, 2),
                "pnl_contribution": round(p / total_pnl, 4) if total_pnl else 0.0,
            })
        symbols.sort(key=lambda x: x["total_pnl"], reverse=True)
        return {
            "total_fills": self.total_fills(), "total_pnl": round(total_pnl, 2),
            "symbols": symbols, "strategies": list(self._strategy_fills.keys()),
        }
