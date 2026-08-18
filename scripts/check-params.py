#!/usr/bin/env python3
"""Guard against drift between the contract's SM-2 parameters and the Rust mirror.

The contract re-derives every schedule transition and rejects a client proposal that
disagrees. That makes the two copies of these constants a real hazard: change one and the
system does not break loudly, it just starts refusing every review with a message about an
illegal transition, pointing nowhere near the actual cause.

Compares `pure circuit NAME(): T { return V; }` in contracts/src/srs.compact against
`pub const NAME: T = V;` in crates/srs-core/src/params.rs. Constants that exist on only one
side are reported but not failed — the Rust side legitimately carries client-only policy such
as DEFAULT_SKEW_MARGIN_SECS, which is not a protocol rule.

Exits non-zero on drift.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONTRACT = ROOT / "contracts" / "src" / "srs.compact"
PARAMS = ROOT / "crates" / "srs-core" / "src" / "params.rs"

# Client-only policy, deliberately absent from the contract.
RUST_ONLY_ALLOWED = {"DEFAULT_SKEW_MARGIN_SECS"}


def main() -> int:
    for path in (CONTRACT, PARAMS):
        if not path.is_file():
            print(f"check-params: missing {path}", file=sys.stderr)
            return 2

    contract_consts = dict(
        re.findall(
            r"pure circuit (\w+)\(\):\s*\w+<\d+>\s*\{\s*return\s+(\d+);",
            CONTRACT.read_text(),
        )
    )
    rust_consts = {
        name: value.replace("_", "")
        for name, value in re.findall(
            r"pub const (\w+):\s*\w+\s*=\s*([\d_]+);", PARAMS.read_text()
        )
    }

    if not contract_consts or not rust_consts:
        print("check-params: parsed nothing — has the syntax changed?", file=sys.stderr)
        return 2

    drift = []
    print(f"{'constant':<26}{'contract':>10}{'rust':>10}")
    for name in sorted(contract_consts.keys() & rust_consts.keys()):
        contract_value, rust_value = contract_consts[name], rust_consts[name]
        marker = "" if contract_value == rust_value else "  <-- DRIFT"
        if marker:
            drift.append(name)
        print(f"{name:<26}{contract_value:>10}{rust_value:>10}{marker}")

    contract_only = sorted(contract_consts.keys() - rust_consts.keys())
    rust_only = sorted(rust_consts.keys() - contract_consts.keys() - RUST_ONLY_ALLOWED)

    if contract_only:
        print(f"\nin the contract but not mirrored in Rust: {', '.join(contract_only)}")
    if rust_only:
        print(f"in Rust but not in the contract: {', '.join(rust_only)}")

    if drift:
        print(f"\nFAIL: {len(drift)} constant(s) disagree: {', '.join(drift)}", file=sys.stderr)
        return 1

    print(f"\nOK: {len(contract_consts.keys() & rust_consts.keys())} shared constants agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
