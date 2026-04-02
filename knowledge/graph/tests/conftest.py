from __future__ import annotations

import os


def pytest_configure(config) -> None:
    # Default tests to an offline-safe embedding mode unless caller explicitly opts in.
    os.environ.setdefault("OBSIDI_EMBED_PROVIDER", "local")
