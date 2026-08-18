"""Generate cross-implementation interop vectors from the OFFICIAL Python ap2.sdk.

The reference implementation SIGNS real payment-mandate chains; the TypeScript
suite (test/vectors.test.ts) then VERIFIES them. A green vector suite is proof
that ap2-protocol-js interoperates with the reference on the wire (same SD-JWT
`~~`-joined chain format, same crypto, same binding + constraint semantics) --
not just that it is self-consistent.

This is a developer tool, NOT part of the published package (`files` ships only
dist + docs). It writes test/fixtures/vectors.json.

## Requirements

The reference SDK is Google's Python ap2.sdk in the google-agentic-commerce/AP2
repo. Point AP2_PYTHON_SDK at its `code/sdk/python` dir and run with a Python
that has its deps (cryptography, jwcrypto, pydantic, sd-jwt):

    AP2_PYTHON_SDK=/path/to/AP2/code/sdk/python \
    /path/to/AP2/.venv/bin/python scripts/generate-fixtures.py

If AP2_PYTHON_SDK is unset it defaults to the sibling checkout used in dev.

## Vector schema (consumed by test/vectors.test.ts)

    {
      "name": str,
      "kind": "chain",
      "issuer_jwk": { public EC P-256 JWK + alg },   # resolveKey target
      "token": str,                                    # ~~-joined dSD-JWT chain
      "expected_aud": str, "expected_nonce": str,
      "should_verify": bool,                           # verifyMandate (crypto/binding/aud/nonce)
      # constraint layer (optional):
      "expected_open_checkout_hash": str,
      "expected_transaction_id": str,
      "constraints_ok": bool                           # verifyPaymentMandateChain -> no violations
    }
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "test", "fixtures", "vectors.json"))

_DEFAULT_SDK = os.path.normpath(
    os.path.join(HERE, "..", "..", "AP2", "code", "sdk", "python")
)
SDK_PYTHON = os.environ.get("AP2_PYTHON_SDK", _DEFAULT_SDK)


def _load_reference():
    if not os.path.isdir(SDK_PYTHON):
        print(
            f"reference Python ap2.sdk not found at {SDK_PYTHON}\n"
            "set AP2_PYTHON_SDK to the AP2 repo's code/sdk/python dir.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    sys.path.insert(0, SDK_PYTHON)
    try:
        from cryptography.hazmat.primitives.asymmetric import ec  # noqa: F401
        from jwcrypto.jwk import JWK  # noqa: F401
        from ap2.sdk.mandate import MandateClient  # noqa: F401
        from ap2.sdk.payment_mandate_chain import PaymentMandateChain  # noqa: F401
    except Exception as exc:
        print(
            f"could not import the reference ap2.sdk or its deps: {exc}\n"
            "install with: <venv>/bin/python -m pip install "
            "cryptography jwcrypto pydantic sd-jwt",
            file=sys.stderr,
        )
        raise SystemExit(1)


_load_reference()

from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from jwcrypto.jwk import JWK  # noqa: E402
from ap2.sdk.mandate import MandateClient  # noqa: E402
from ap2.sdk.generated.open_payment_mandate import (  # noqa: E402
    AmountRange,
    OpenPaymentMandate,
    PaymentReference,
)
from ap2.sdk.generated.payment_mandate import PaymentMandate  # noqa: E402
from ap2.sdk.generated.types.amount import Amount  # noqa: E402
from ap2.sdk.generated.types.merchant import Merchant  # noqa: E402
from ap2.sdk.generated.types.payment_instrument import PaymentInstrument  # noqa: E402
from ap2.sdk.generated.checkout_mandate import CheckoutMandate  # noqa: E402
from ap2.sdk.generated.open_checkout_mandate import (  # noqa: E402
    Item as MandateItem,
    LineItemRequirements,
    LineItems,
    OpenCheckoutMandate,
)
from ap2.sdk.generated.types.item import Item as CheckoutItem  # noqa: E402
from ap2.sdk.generated.types.line_item import LineItem  # noqa: E402
from ap2.sdk.generated.types.total import Total  # noqa: E402
from ap2.sdk.generated.types.checkout import Checkout, Status  # noqa: E402
from ap2.sdk.generated.types.link import Link  # noqa: E402
from ap2.sdk.utils import b64url_encode  # noqa: E402
import base64  # noqa: E402
import hashlib  # noqa: E402


def _sha256_b64url(text: str) -> str:
    """Match ap2-protocol-js computeSha256B64url: base64url(sha256(utf8)), no pad."""
    return base64.urlsafe_b64encode(hashlib.sha256(text.encode("utf-8")).digest()).decode().rstrip("=")


def _checkout_jwt(line_items) -> str:
    subtotal = sum(li.item.price * li.quantity for li in line_items)
    checkout = Checkout(
        id="chk_test",
        merchant=Merchant(id="m-1", name="Store"),
        line_items=line_items,
        status=Status.incomplete,
        currency="USD",
        totals=[Total(type="total", amount=subtotal)],
        links=[Link(type="terms_of_service", url="https://example.com/tos")],
    )
    body = b64url_encode(checkout.model_dump_json(exclude_none=True).encode("utf-8"))
    return f"hdr.{body}.sig"  # only the payload segment is load-bearing


def _line_item(sku: str, title: str, qty: int, price: int) -> LineItem:
    return LineItem(
        id=f"li_{sku}",
        item=CheckoutItem(id=sku, title=title, price=price),
        quantity=qty,
        totals=[Total(type="total", amount=price * qty)],
    )


def make_key(kid: str) -> JWK:
    priv = ec.generate_private_key(ec.SECP256R1())
    jwk = JWK.from_pyca(priv)
    d = json.loads(jwk.export())
    d["kid"] = kid
    return JWK.from_json(json.dumps(d))


def public_jwk(key: JWK) -> dict:
    """Public EC JWK dict; jwcrypto omits alg, so add it for the TS verifier."""
    d = json.loads(key.export_public())
    d["alg"] = "ES256"
    return d


def sign_chain(issuer_key, holder_key, constraints, closed, aud, nonce) -> str:
    client = MandateClient()
    open_tok = client.create(
        payloads=[OpenPaymentMandate(
            constraints=constraints,
            cnf={"jwk": json.loads(holder_key.export_public())},
        )],
        issuer_key=issuer_key,
    )
    return client.present(
        holder_key=holder_key, mandate_token=open_tok,
        payloads=[closed], aud=aud, nonce=nonce,
    )


def main() -> int:
    issuer = make_key("issuer-key-1")
    holder = make_key("agent-key-1")
    unrelated = make_key("evil-key-1")
    issuer_pub = public_jwk(issuer)

    AUD, NONCE, TXID, HASH = "merchant", "merchant-nonce-abc123", "tx_1", "checkout-hash-xyz"

    # A cryptographically valid chain: closed amount 1000 within open [100, 5000].
    valid_tok = sign_chain(
        issuer, holder,
        [AmountRange(currency="USD", max=5000, min=100),
         PaymentReference(conditional_transaction_id=HASH)],
        PaymentMandate(
            transaction_id=TXID,
            payee=Merchant(name="Shop", id="s-1"),
            payment_amount=Amount(amount=1000, currency="USD"),
            payment_instrument=PaymentInstrument(id="pi-1", type="credit"),
        ),
        AUD, NONCE,
    )

    # Same shape, closed amount 10000 above the open max 5000: crypto-valid,
    # constraint-invalid. Proves the two verification layers interop separately.
    over_tok = sign_chain(
        issuer, holder,
        [AmountRange(currency="USD", max=5000, min=100),
         PaymentReference(conditional_transaction_id=HASH)],
        PaymentMandate(
            transaction_id="tx_over",
            payee=Merchant(name="Shop", id="s-1"),
            payment_amount=Amount(amount=10000, currency="USD"),
            payment_instrument=PaymentInstrument(id="pi-1", type="credit"),
        ),
        AUD, NONCE,
    )

    tampered = valid_tok[:-6] + "XXXXX" + valid_tok[-1]

    vectors = [
        {  # the crown jewel: reference-signed chain must verify in TS, crypto + constraints
            "name": "reference valid payment chain (amount within range)",
            "kind": "chain", "issuer_jwk": issuer_pub, "token": valid_tok,
            "expected_aud": AUD, "expected_nonce": NONCE, "should_verify": True,
            "expected_open_checkout_hash": HASH, "expected_transaction_id": TXID,
            "constraints_ok": True,
        },
        {  # crypto-valid but over budget: verifyMandate ok, constraint layer rejects
            "name": "reference over-budget chain (crypto valid, constraint invalid)",
            "kind": "chain", "issuer_jwk": issuer_pub, "token": over_tok,
            "expected_aud": AUD, "expected_nonce": NONCE, "should_verify": True,
            "expected_open_checkout_hash": HASH, "expected_transaction_id": "tx_over",
            "constraints_ok": False,
        },
        {  # PaymentReference present but no expected hash supplied -> constraint violation
            "name": "reference valid chain, missing expected_open_checkout_hash",
            "kind": "chain", "issuer_jwk": issuer_pub, "token": valid_tok,
            "expected_aud": AUD, "expected_nonce": NONCE, "should_verify": True,
            "expected_transaction_id": TXID, "constraints_ok": False,
        },
        {  # replay defense: wrong audience
            "name": "reference chain, wrong expected aud",
            "kind": "chain", "issuer_jwk": issuer_pub, "token": valid_tok,
            "expected_aud": "not-the-merchant", "expected_nonce": NONCE,
            "should_verify": False,
        },
        {  # replay defense: wrong nonce
            "name": "reference chain, wrong expected nonce",
            "kind": "chain", "issuer_jwk": issuer_pub, "token": valid_tok,
            "expected_aud": AUD, "expected_nonce": "wrong-nonce",
            "should_verify": False,
        },
        {  # integrity: tampered chain
            "name": "reference chain, tampered bytes",
            "kind": "chain", "issuer_jwk": issuer_pub, "token": tampered,
            "expected_aud": AUD, "expected_nonce": NONCE, "should_verify": False,
        },
        {  # authenticity: verified under an unrelated issuer key
            "name": "reference chain, wrong issuer key",
            "kind": "chain", "issuer_jwk": public_jwk(unrelated), "token": valid_tok,
            "expected_aud": AUD, "expected_nonce": NONCE, "should_verify": False,
        },
    ]

    # ── Checkout mandate chains with a line_items constraint ─────────────────
    client = MandateClient()
    line_constraint = LineItems(items=[
        LineItemRequirements(id="r1", acceptable_items=[MandateItem(id="SKU-A", title="Widget")], quantity=2),
        LineItemRequirements(
            id="r2",
            acceptable_items=[MandateItem(id="SKU-B", title="Gadget"), MandateItem(id="SKU-C", title="Gizmo")],
            quantity=1,
        ),
    ])

    def checkout_vector(name, cart, constraints_ok):
        open_tok = client.create(
            payloads=[OpenCheckoutMandate(
                constraints=[line_constraint],
                cnf={"jwk": json.loads(holder.export_public())},
            )],
            issuer_key=issuer,
        )
        cjwt = _checkout_jwt(cart)
        chain = client.present(
            holder_key=holder, mandate_token=open_tok,
            payloads=[CheckoutMandate(checkout_jwt=cjwt, checkout_hash=_sha256_b64url(cjwt))],
            aud=AUD, nonce=NONCE,
        )
        return {
            "name": name, "kind": "checkout-chain", "issuer_jwk": issuer_pub,
            "token": chain, "checkout_jwt": cjwt,
            "expected_aud": AUD, "expected_nonce": NONCE,
            "should_verify": True, "constraints_ok": constraints_ok,
        }

    vectors += [
        checkout_vector(
            "reference checkout chain, line-items satisfied",
            [_line_item("SKU-A", "Widget", 2, 500), _line_item("SKU-B", "Gadget", 1, 300)], True),
        checkout_vector(
            "reference checkout chain, line-items over quantity",
            [_line_item("SKU-A", "Widget", 3, 500), _line_item("SKU-B", "Gadget", 1, 300)], False),
        checkout_vector(
            "reference checkout chain, line-items uncovered sku",
            [_line_item("SKU-A", "Widget", 2, 500), _line_item("SKU-Z", "Contraband", 1, 999)], False),
    ]

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump({"vectors": vectors}, fh, indent=2)
        fh.write("\n")
    print(f"wrote {len(vectors)} reference-signed vectors to {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
