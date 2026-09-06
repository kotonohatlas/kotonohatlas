"""Build the reusable country/language access runtime owned by Kotonohatlas."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from atlas_i18n import locales_config, public_locale_identity
from atlas_paths import BROWSER_DIR


TEMPLATE_PATH = BROWSER_DIR / "language-atlas-access.js"


def language_speaker_orders(
    estimates: dict[str, int],
    locale_items: list[dict] | None = None,
) -> dict[str, int]:
    orders: dict[str, int] = {}
    for item in locale_items if locale_items is not None else locales_config()["locales"]:
        estimate = estimates.get(str(item["locale"]))
        if not isinstance(estimate, int) or estimate <= 0:
            continue
        identity = public_locale_identity(item)
        order = len(str(estimate)) - 1
        for key in (identity, identity.split("-", 1)[0]):
            orders[key] = max(order, orders.get(key, 0))
    return dict(sorted(orders.items()))


def build_javascript(
    estimates: dict[str, int],
    locale_items: list[dict] | None = None,
) -> str:
    from jsmin import jsmin

    marker = "__LANGUAGE_SPEAKER_ORDERS__"
    template = TEMPLATE_PATH.read_text(encoding="utf-8")
    if template.count(marker) != 1:
        raise ValueError(f"{TEMPLATE_PATH} must contain exactly one {marker} marker")
    packed = json.dumps(
        language_speaker_orders(estimates, locale_items),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return jsmin(template.replace(marker, packed), quote_chars="'\"`") + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Build the standalone access-language runtime")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "dist" / "language-atlas-access.js",
    )
    args = parser.parse_args()

    from speaker_estimates import build_catalog

    estimates = build_catalog().get("estimates") or {}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(build_javascript(estimates), encoding="utf-8")
    print(f"access_runtime={args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
