"""
File-based cache for macro data providers.
Stores last successful fetch results in JSON files under data/cache/ so that
when an upstream API fails, the most recent good value can be served.

Cache layout:
    data/cache/
        fred_FEDFUNDS.json
        fred_DGS10.json
        fred_VIXCLS.json
        fred_SP500.json
        bok_base_rate.json
        bok_usd_krw.json
        krx_vkospi.json
        krx_kospi.json

Each file:
    {
        "value": <payload>,
        "fetched_at": "2026-10-13T04:47:35.834726Z",
        "source": "fred" | "bok" | "krx" | ...,
        "key": "<cache_key>"
    }
"""

import json
import logging
import os
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)


class FileCache:
    """Thread-safe file-based cache with one file per key."""

    def __init__(self, cache_dir: str = "data/cache"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        logger.info(f"FileCache initialized at {self.cache_dir.absolute()}")

    def _path_for(self, key: str) -> Path:
        # Sanitize key for filesystem
        safe = "".join(c if c.isalnum() or c in ("_", "-", ".") else "_" for c in key)
        return self.cache_dir / f"{safe}.json"

    def get(self, key: str, max_age_seconds: Optional[float] = None) -> Optional[Dict[str, Any]]:
        """
        Retrieve cached value for key.

        Args:
            key: cache key
            max_age_seconds: if set, return None if cache is older than this.
                             If None, return regardless of age (for failure fallback).

        Returns:
            The cached payload (the "value" field), or None if not found/expired.
        """
        path = self._path_for(key)
        if not path.exists():
            return None

        try:
            with self._lock:
                with open(path, "r", encoding="utf-8") as f:
                    entry = json.load(f)

            if max_age_seconds is not None:
                fetched_at = datetime.fromisoformat(entry["fetched_at"].replace("Z", "+00:00"))
                age = (datetime.now(fetched_at.tzinfo) - fetched_at).total_seconds()
                if age > max_age_seconds:
                    logger.debug(f"Cache expired for {key} (age={age:.0f}s > {max_age_seconds}s)")
                    return None

            return entry.get("value")

        except (json.JSONDecodeError, KeyError, ValueError, OSError) as e:
            logger.warning(f"Failed to read cache for {key}: {e}")
            return None

    def get_with_metadata(self, key: str) -> Optional[Dict[str, Any]]:
        """Retrieve full cache entry including fetched_at and source."""
        path = self._path_for(key)
        if not path.exists():
            return None
        try:
            with self._lock:
                with open(path, "r", encoding="utf-8") as f:
                    return json.load(f)
        except (json.JSONDecodeError, OSError) as e:
            logger.warning(f"Failed to read cache entry for {key}: {e}")
            return None

    def set(self, key: str, value: Any, source: str = "unknown") -> bool:
        """
        Store value under key with current timestamp.

        Returns:
            True on success, False on failure.
        """
        path = self._path_for(key)
        entry = {
            "value": value,
            "fetched_at": datetime.utcnow().isoformat() + "Z",
            "source": source,
            "key": key,
        }
        try:
            with self._lock:
                # Atomic write: write to temp file then rename
                tmp = path.with_suffix(".json.tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(entry, f, ensure_ascii=False, indent=2)
                tmp.replace(path)
            logger.debug(f"Cached {key} (source={source})")
            return True
        except OSError as e:
            logger.warning(f"Failed to write cache for {key}: {e}")
            return False

    def age_seconds(self, key: str) -> Optional[float]:
        """Return age of cached entry in seconds, or None if not cached."""
        entry = self.get_with_metadata(key)
        if not entry:
            return None
        try:
            fetched_at = datetime.fromisoformat(entry["fetched_at"].replace("Z", "+00:00"))
            return (datetime.now(fetched_at.tzinfo) - fetched_at).total_seconds()
        except (KeyError, ValueError):
            return None
