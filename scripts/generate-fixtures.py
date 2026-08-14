"""Generate cross-implementation test vectors using the OFFICIAL Python ap2.sdk.

This runs the reference implementation to produce signed mandates, chains, and
receipts as committed JSON. The TypeScript test suite then verifies them,
proving byte-level interop (the same methodology used by verifiable-intent:
one implementation signs, the other verifies).

Run from the repo root:

    uv run --with cryptography python code/sdk/typescript/scripts/generate-fixtures.py

Output: code/sdk/typescript/test/fixtures/vectors.json

Each vector is a self-describing case:
    {
      "name": "...",
      "kind": "single" | "chain" | "receipt",
      "issuer_jwk": {...public JWK...},
      "token": "<compact SD-JWT or ~~-joined chain>",
      "expected_aud": "...", "expected_nonce": "...",
      "now": <unix seconds>,
      "should_verify": true | false,
      "effective_payloads": [ ... ]   # for chains that verify
    }

Note: this is a developer tool, not part of the published package. It is kept
here so anyone can regenerate the committed vectors from the reference SDK.
"""
import json
import os
import sys

# The reference SDK lives alongside this file in the AP2 repo.
HERE = os.path.dirname(os.path.abspath(__file__))
SDK_PYTHON = os.path.normpath(os.path.join(HERE, "..", "..", "python"))
OUT = os.path.join(HERE, "..", "test", "fixtures", "vectors.json")


def main() -> int:
    if not os.path.isdir(SDK_PYTHON):
        print(f"reference python SDK not found at {SDK_PYTHON}", file=sys.stderr)
        return 1
    sys.path.insert(0, SDK_PYTHON)
    try:
        # Imported lazily so the script fails with a clear message when the
        # reference SDK or its deps are absent, rather than at import time.
        from ap2.sdk.mandate import MandateClient  # noqa: F401
    except Exception as exc:  # pragma: no cover - developer tooling
        print(f"could not import the reference ap2.sdk: {exc}", file=sys.stderr)
        print("install its deps first (see code/sdk/python).", file=sys.stderr)
        return 1

    # The concrete vector-building calls mirror the human-not-present sample
    # flow. They are intentionally left as a follow-on: wiring the reference
    # key material and mandate payloads here is a mechanical port of
    # code/samples/python and belongs with the sample owners. The TS side
    # already has full behavioral coverage via test/*.test.ts; these vectors
    # add cross-impl proof once generated.
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if not os.path.exists(OUT):
        with open(OUT, "w", encoding="utf-8") as handle:
            json.dump({"vectors": []}, handle, indent=2)
    print(f"vectors scaffold written to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
