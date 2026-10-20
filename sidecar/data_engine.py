"""
Macro Data Engine - Aggregates macroeconomic data from multiple providers.
Produces regime classifications with explicit reasoning so that decisions
are explainable (e.g., "defensive because VIX > 25 and rising").
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Dict, Any, List, Optional
from datetime import datetime

from cache import FileCache
from providers.fred_provider import FREDProvider
from providers.bok_provider import BOKProvider
from providers.krx_provider import KRXProvider

logger = logging.getLogger(__name__)


class MacroDataProvider:
    """Aggregates FRED, BOK, KRX data and produces regime context."""

    def __init__(self, cache_dir: str = "data/cache"):
        self.cache = FileCache(cache_dir=cache_dir)
        self.fred = FREDProvider(cache=self.cache)
        self.bok = BOKProvider(cache=self.cache)
        self.krx = KRXProvider(cache=self.cache)
        logger.info("MacroDataProvider initialized")

    def get_regime_context(self) -> Dict[str, Any]:
        """
        Get comprehensive macro regime context with explainability.

        Returns dict with regime classifications AND a `reasons` list explaining
        each decision, plus `indicators` containing the raw values used.
        """
        reasons: List[str] = []
        indicators: Dict[str, Any] = {}

        # Fetch raw data in PARALLEL (providers are independent; each has its own
        # cache/timeout, and requests/urllib release the GIL on network I/O).
        # Serial fetch summed all provider latencies (~4.9s); parallel takes the max.
        _fetchers = {
            "fed_funds": self.fred.get_fed_funds_rate,
            "us_10y": lambda: self.fred.get_treasury_rate("10Y"),
            "vix": self.fred.get_vix,
            "sp500": self.fred.get_sp500,
            "kr_base": self.bok.get_base_rate,
            "usd_krw": self.bok.get_usd_krw_rate,
            "kospi_vol": self.krx.get_kospi200_volatility,
            "kospi_idx": self.krx.get_kospi_index,
        }
        with ThreadPoolExecutor(max_workers=len(_fetchers)) as ex:
            _futures = {k: ex.submit(fn) for k, fn in _fetchers.items()}
            _results = {}
            for k, fut in _futures.items():
                try:
                    _results[k] = fut.result()
                except Exception as e:
                    logger.warning(f"macro fetch {k} failed: {e}")
                    _results[k] = None
        fed_funds = _results["fed_funds"]
        us_10y = _results["us_10y"]
        vix = _results["vix"]
        sp500 = _results["sp500"]
        kr_base = _results["kr_base"]
        usd_krw = _results["usd_krw"]
        kospi_vol = _results["kospi_vol"]
        kospi_idx = _results["kospi_idx"]

        indicators.update({
            "fed_funds": fed_funds,
            "us_10y": us_10y,
            "vix": vix,
            "sp500": sp500,
            "kr_base": kr_base,
            "usd_krw": usd_krw,
            "kospi_vol": kospi_vol,
            "kospi_idx": kospi_idx,
        })

        # Component classifications (each appends to reasons)
        interest_rate_trend = self._classify_interest_rate_trend(
            fed_funds, us_10y, kr_base, reasons
        )
        volatility_regime = self._classify_volatility_regime(vix, kospi_vol, reasons)
        usd_krw_trend = self._classify_usd_krw_trend(usd_krw, reasons)
        risk_appetite = self._classify_risk_appetite(vix, sp500, kospi_vol, reasons)
        regime = self._classify_overall_regime(
            interest_rate_trend, volatility_regime, risk_appetite, reasons
        )

        return {
            "regime": regime,
            "interest_rate_trend": interest_rate_trend,
            "volatility_regime": volatility_regime,
            "usd_krw_trend": usd_krw_trend,
            "risk_appetite": risk_appetite,
            "reasons": reasons,
            "indicators": indicators,
            "timestamp": datetime.utcnow().isoformat() + "Z",
        }

    # ------------------------------------------------------------------
    # Component classifiers (each appends human-readable reasons)
    # ------------------------------------------------------------------

    def _classify_interest_rate_trend(
        self, fed_funds, us_10y, kr_base, reasons: List[str]
    ) -> str:
        """Combine Fed Funds, US 10Y, KR base rate trends."""
        trends = []
        for label, data, unit in [
            ("Fed Funds", fed_funds, "%"),
            ("US10Y", us_10y, "%"),
            ("KR base", kr_base, "%"),
        ]:
            if data and data.get("trend"):
                trends.append(data["trend"])
                src = "cache" if data.get("from_cache") else "API"
                reasons.append(f"{label}={data.get('value')}{unit} trend={data['trend']} ({src})")

        if not trends:
            reasons.append("No interest rate data -> stable")
            return "stable"
        rising = trends.count("rising")
        falling = trends.count("falling")
        if rising > falling:
            return "rising"
        if falling > rising:
            return "falling"
        return "stable"

    def _classify_volatility_regime(self, vix, kospi_vol, reasons: List[str]) -> str:
        """Combine VIX and KOSPI200 vol; most conservative wins."""
        regimes: List[str] = []
        order = {"low": 0, "normal": 1, "high": 2, "extreme": 3}

        if vix and vix.get("value") is not None:
            v = vix["value"]
            src = "cache" if vix.get("from_cache") else "FRED"
            if v < 15:
                r = "low"
            elif v < 25:
                r = "normal"
            elif v < 35:
                r = "high"
            else:
                r = "extreme"
            regimes.append(r)
            reasons.append(f"VIX={v} -> {r} ({src})")

        if kospi_vol and kospi_vol.get("value") is not None:
            r = kospi_vol.get("regime", "normal")
            v = kospi_vol.get("value")
            src = "cache" if kospi_vol.get("from_cache") else kospi_vol.get("source", "krx")
            regimes.append(r)
            reasons.append(f"KOSPI200 vol={v}% -> {r} ({src})")

        if not regimes:
            reasons.append("No volatility data -> normal")
            return "normal"
        return max(regimes, key=lambda r: order.get(r, 1))

    def _classify_usd_krw_trend(self, usd_krw, reasons: List[str]) -> str:
        """Classify USD/KRW trend."""
        if usd_krw and usd_krw.get("trend"):
            src = "cache" if usd_krw.get("from_cache") else "BOK"
            reasons.append(f"USD/KRW={usd_krw.get('value')} trend={usd_krw['trend']} ({src})")
            return usd_krw["trend"]
        reasons.append("No USD/KRW data -> stable")
        return "stable"

    def _classify_risk_appetite(
        self, vix, sp500, kospi_vol, reasons: List[str]
    ) -> str:
        """
        aggressive = low VIX + rising equities (risk-on)
        defensive  = high VIX or falling equities (risk-off)
        neutral    = otherwise
        """
        vix_value = vix.get("value") if vix else None
        vix_change = (vix or {}).get("change_pct", 0) or 0
        sp_change = (sp500 or {}).get("change_pct", 0) or 0

        if vix_value is not None:
            src = "cache" if (vix or {}).get("from_cache") else "FRED"
            if vix_value >= 30:
                reasons.append(f"VIX={vix_value} very high -> defensive ({src})")
                return "defensive"
            if vix_value >= 25 and vix_change > 0:
                reasons.append(
                    f"VIX={vix_value} (+{vix_change}%) high and rising -> defensive ({src})"
                )
                return "defensive"
            if vix_value < 15 and vix_change <= 0 and sp_change >= 0:
                reasons.append(
                    f"VIX={vix_value} ({vix_change:+.2f}%), S&P {sp_change:+.2f}% -> aggressive ({src})"
                )
                return "aggressive"

        if sp_change <= -1.5:
            reasons.append(f"S&P 500 {sp_change:+.2f}% sharp drop -> defensive")
            return "defensive"

        reasons.append(f"VIX={vix_value}, S&P {sp_change:+.2f}% -> neutral")
        return "neutral"

    def _classify_overall_regime(
        self, interest_rate_trend: str, volatility_regime: str,
        risk_appetite: str, reasons: List[str],
    ) -> str:
        """Synthesize overall regime from components."""
        if volatility_regime == "extreme" or risk_appetite == "defensive":
            reasons.append(
                f"Overall: vol={volatility_regime} + risk={risk_appetite} -> risk_off_crisis"
            )
            return "risk_off_crisis"
        if (volatility_regime == "low" and interest_rate_trend == "stable"
                and risk_appetite == "aggressive"):
            reasons.append("Overall: low vol + stable rates + aggressive -> goldilocks")
            return "goldilocks"
        if interest_rate_trend == "rising" and volatility_regime in ("normal", "high"):
            reasons.append("Overall: rising rates + elevated vol -> tightening")
            return "tightening"
        if interest_rate_trend == "falling" and volatility_regime == "low":
            reasons.append("Overall: falling rates + low vol -> easing")
            return "easing"
        reasons.append("Overall: no clear signal -> normal")
        return "normal"
