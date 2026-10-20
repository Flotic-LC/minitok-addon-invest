"""
BOK (Bank of Korea) Provider
Fetches Korean economic indicators: base rate and USD/KRW exchange rate.
Uses BOK ECOS API. On failure, falls back to file-cached last good value.
"""

import os
import logging
from typing import Dict, Any, Optional
import requests
from datetime import datetime, timedelta

from cache import FileCache

logger = logging.getLogger(__name__)


class BOKProvider:
    """Provider for Bank of Korea economic data with file-cache fallback."""

    BASE_URL = "https://ecos.bok.or.kr/api"

    SERIES_BASE_RATE = "722Y001"
    SERIES_USD_KRW = "731Y001"
    ITEM_BASE_RATE = "0101000"   # 한국은행 기준금리
    ITEM_USD_KRW = "0000001"     # 원/미국달러(매매기준율)

    def __init__(self, cache: Optional[FileCache] = None):
        self.api_key = os.getenv("BOK_API_KEY", "")
        self.cache = cache or FileCache()
        if not self.api_key:
            logger.warning("BOK_API_KEY not set - BOK will use cache/fallback only")

    def get_base_rate(self) -> Optional[Dict[str, Any]]:
        """Get Korean base rate."""
        cache_key = "bok_base_rate"
        result = self._fetch_ecos(
            series_code=self.SERIES_BASE_RATE,
            item_code=self.ITEM_BASE_RATE,
            cache_key=cache_key,
            trend_threshold=0.10,
            unit="rate",
        )
        return result if result is not None else self._cached_or_none(cache_key, "base_rate")

    def get_usd_krw_rate(self) -> Optional[Dict[str, Any]]:
        """Get USD/KRW exchange rate."""
        cache_key = "bok_usd_krw"
        result = self._fetch_ecos(
            series_code=self.SERIES_USD_KRW,
            item_code=self.ITEM_USD_KRW,
            cache_key=cache_key,
            trend_threshold_pct=1.0,
            unit="fx",
        )
        return result if result is not None else self._cached_or_none(cache_key, "usd_krw")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _fetch_ecos(
        self,
        series_code: str,
        item_code: str,
        cache_key: str,
        trend_threshold: float = 0.10,
        trend_threshold_pct: Optional[float] = None,
        unit: str = "rate",
    ) -> Optional[Dict[str, Any]]:
        """Fetch BOK ECOS series and compute trend. Caches on success."""
        if not self.api_key:
            return None

        try:
            end_date = datetime.now()
            start_date = end_date - timedelta(days=60)
            date_range = f"{start_date.strftime('%Y%m%d')}/{end_date.strftime('%Y%m%d')}"

            url = (
                f"{self.BASE_URL}/StatisticSearch/{self.api_key}/json/kr/1/20/"
                f"{series_code}/D/{date_range}/{item_code}"
            )
            response = requests.get(url, timeout=10)
            response.raise_for_status()
            data = response.json()

            if "RESULT" in data:
                code = data["RESULT"].get("CODE", "")
                msg = data["RESULT"].get("MESSAGE", "")
                logger.warning(f"BOK API error {code}: {msg}")
                return None

            rows = (data.get("StatisticSearch") or {}).get("row") or []
            if not rows:
                logger.warning(f"No BOK data for {series_code}/{item_code}")
                return None

            rows.sort(key=lambda r: r.get("TIME", ""), reverse=True)
            latest = rows[0]
            latest_value = float(latest["DATA_VALUE"])

            result: Dict[str, Any] = {
                "value": latest_value,
                "series_code": series_code,
                "item_code": item_code,
                "date": latest.get("TIME", ""),
                "source": "bok",
            }

            if len(rows) >= 2:
                prev_value = float(rows[1]["DATA_VALUE"])
                diff = latest_value - prev_value
                if trend_threshold_pct is not None and prev_value != 0:
                    change_pct = (diff / prev_value) * 100
                    result["change_pct"] = round(change_pct, 3)
                    if change_pct > trend_threshold_pct:
                        result["trend"] = "strengthening" if unit == "fx" else "rising"
                    elif change_pct < -trend_threshold_pct:
                        result["trend"] = "weakening" if unit == "fx" else "falling"
                    else:
                        result["trend"] = "stable"
                else:
                    result["diff"] = round(diff, 4)
                    if diff > trend_threshold:
                        result["trend"] = "rising"
                    elif diff < -trend_threshold:
                        result["trend"] = "falling"
                    else:
                        result["trend"] = "stable"
            else:
                result["trend"] = "stable"

            self.cache.set(cache_key, result, source="bok")
            return result

        except requests.RequestException as e:
            logger.error(f"BOK request failed for {series_code}: {e}")
            return None
        except (ValueError, KeyError) as e:
            logger.error(f"BOK response parse error for {series_code}: {e}")
            return None

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
            f"Using cached BOK value for {label} (age={result['cache_age_seconds']:.0f}s)"
        )
        return result
