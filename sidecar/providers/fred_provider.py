"""
FRED (Federal Reserve Economic Data) Provider
Fetches US economic indicators: Fed Funds Rate, Treasury yields, VIX, S&P 500.
On API failure, falls back to file-cached last good value.
"""

import os
import time
import logging
from typing import Dict, Any, Optional
import requests

from cache import FileCache

logger = logging.getLogger(__name__)


class FREDProvider:
    """Provider for FRED economic data with file-cache fallback."""

    BASE_URL = "https://api.stlouisfed.org/fred"

    SERIES_FEDFUNDS = "FEDFUNDS"
    SERIES_DGS10 = "DGS10"
    SERIES_VIX = "VIXCLS"
    SERIES_SP500 = "SP500"

    def __init__(self, cache: Optional[FileCache] = None):
        self.api_key = os.getenv("FRED_API_KEY", "")
        self.cache = cache or FileCache()
        if not self.api_key:
            logger.warning("FRED_API_KEY not set - FRED will use cache/fallback only")

    def get_fed_funds_rate(self) -> Optional[Dict[str, Any]]:
        """Get Effective Federal Funds Rate."""
        cache_key = f"fred_{self.SERIES_FEDFUNDS}"
        result = self._fetch_series(
            series_id=self.SERIES_FEDFUNDS,
            limit=12,
            cache_key=cache_key,
            trend_lookback=6,
            trend_threshold=0.25,
        )
        return result if result is not None else self._cached_or_none(cache_key)

    def get_treasury_rate(self, maturity: str = "10Y") -> Optional[Dict[str, Any]]:
        """Get US Treasury rate for specified maturity."""
        series_map = {"3M": "DGS3MO", "2Y": "DGS2", "10Y": "DGS10", "30Y": "DGS30"}
        series_id = series_map.get(maturity, self.SERIES_DGS10)
        cache_key = f"fred_{series_id}"
        result = self._fetch_series(
            series_id=series_id,
            limit=90,
            cache_key=cache_key,
            trend_lookback=30,
            trend_threshold=0.20,
        )
        if result is None:
            return self._cached_or_none(cache_key)
        result["maturity"] = maturity
        return result

    def get_vix(self) -> Optional[Dict[str, Any]]:
        """Get VIX with change percentage."""
        cache_key = f"fred_{self.SERIES_VIX}"
        result = self._fetch_series(
            series_id=self.SERIES_VIX,
            limit=10,
            cache_key=cache_key,
            compute_change_pct=True,
        )
        return result if result is not None else self._cached_or_none(cache_key)

    def get_sp500(self) -> Optional[Dict[str, Any]]:
        """Get S&P 500 with change percentage."""
        cache_key = f"fred_{self.SERIES_SP500}"
        result = self._fetch_series(
            series_id=self.SERIES_SP500,
            limit=10,
            cache_key=cache_key,
            compute_change_pct=True,
        )
        return result if result is not None else self._cached_or_none(cache_key)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_series(
        self,
        series_id: str,
        limit: int,
        cache_key: str,
        trend_lookback: Optional[int] = None,
        trend_threshold: float = 0.20,
        compute_change_pct: bool = False,
    ) -> Optional[Dict[str, Any]]:
        """
        Fetch a FRED series and compute latest value + optional trend/change.
        On success, writes to file cache.
        """
        if not self.api_key:
            return None

        try:
            url = f"{self.BASE_URL}/series/observations"
            params = {
                "series_id": series_id,
                "api_key": self.api_key,
                "file_type": "json",
                "limit": limit,
                "sort_order": "desc",
            }
            # [P9-BACKOFF] Exponential backoff: 3 attempts with 5s, 10s, 20s delays
            max_retries = 3
            backoff_base = 5
            response = None
            last_err = None
            for attempt in range(max_retries):
                try:
                    response = requests.get(url, params=params, timeout=10)
                    response.raise_for_status()
                    break
                except requests.RequestException as retry_err:
                    last_err = retry_err
                    if attempt < max_retries - 1:
                        delay = backoff_base * (2 ** attempt)  # 5s, 10s, 20s
                        logger.warning(
                            f"FRED {series_id} attempt {attempt + 1}/{max_retries} failed: "
                            f"{retry_err}. Retrying in {delay}s..."
                        )
                        time.sleep(delay)
                    else:
                        logger.error(
                            f"FRED {series_id} all {max_retries} attempts failed: {retry_err}"
                        )
                        raise
            data = response.json()

            observations = data.get("observations") or []
            if not observations:
                logger.warning(f"No FRED data for {series_id}")
                return None

            values = []
            for obs in observations:
                v = obs.get("value")
                if v and v != ".":
                    try:
                        values.append((obs.get("date", ""), float(v)))
                    except ValueError:
                        continue

            if not values:
                logger.warning(f"No parseable FRED values for {series_id}")
                return None

            latest_date, latest_value = values[0]
            result: Dict[str, Any] = {
                "value": latest_value,
                "series_id": series_id,
                "date": latest_date,
                "source": "fred",
            }

            if trend_lookback and len(values) >= min(trend_lookback, 5):
                lookback_values = [v for _, v in values[:trend_lookback]]
                avg = sum(lookback_values) / len(lookback_values)
                diff = latest_value - avg
                if diff > trend_threshold:
                    result["trend"] = "rising"
                elif diff < -trend_threshold:
                    result["trend"] = "falling"
                else:
                    result["trend"] = "stable"
                result["avg_lookback"] = round(avg, 4)
                result["diff"] = round(diff, 4)

            if compute_change_pct and len(values) >= 2:
                prev_value = values[1][1]
                if prev_value != 0:
                    result["change_pct"] = round(((latest_value - prev_value) / prev_value) * 100, 3)

            self.cache.set(cache_key, result, source="fred")
            return result

        except requests.RequestException as e:
            logger.error(f"FRED request failed for {series_id}: {e}")
            return None
        except (ValueError, KeyError) as e:
            logger.error(f"FRED response parse error for {series_id}: {e}")
            return None

    def _cached_or_none(self, cache_key: str) -> Optional[Dict[str, Any]]:
        """Return cached value marked as from_cache, or None if no cache."""
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
            f"Using cached FRED value for {cache_key} (age={result['cache_age_seconds']:.0f}s)"
        )
        return result
