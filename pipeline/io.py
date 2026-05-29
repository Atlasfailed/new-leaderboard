from __future__ import annotations

import logging
from pathlib import Path
from typing import Mapping

import pandas as pd
import requests

from .config import DATAMART_URLS

LOGGER = logging.getLogger(__name__)


def download_file(url: str, destination: Path, timeout: int = 180) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = destination.with_suffix(destination.suffix + ".tmp")

    LOGGER.info("Downloading %s", url)
    with requests.get(url, stream=True, timeout=timeout) as response:
        response.raise_for_status()
        with tmp_path.open("wb") as handle:
            for chunk in response.iter_content(chunk_size=1024 * 1024):
                if chunk:
                    handle.write(chunk)

    tmp_path.replace(destination)


def _local_paths(source_dir: Path) -> Mapping[str, Path]:
    return {name: source_dir / f"{name}.parquet" for name in DATAMART_URLS}


def load_sources(
    source_dir: Path | None,
    cache_dir: Path,
    refresh: bool = False,
) -> dict[str, pd.DataFrame]:
    if source_dir is not None:
        paths = _local_paths(source_dir)
        if all(path.exists() for path in paths.values()):
            LOGGER.info("Loading datamarts from %s", source_dir)
            return {name: pd.read_parquet(path) for name, path in paths.items()}
        LOGGER.warning("Local source dir is incomplete; falling back to datamart downloads")

    cache_dir.mkdir(parents=True, exist_ok=True)
    frames: dict[str, pd.DataFrame] = {}

    for name, url in DATAMART_URLS.items():
        path = cache_dir / f"{name}.parquet"
        if refresh or not path.exists():
            download_file(url, path)
        else:
            LOGGER.info("Using cached %s", path)
        frames[name] = pd.read_parquet(path)

    return frames

