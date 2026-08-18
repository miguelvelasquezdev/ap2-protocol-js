"""Reverse-direction interop: verify a TS-signed (ap2-protocol-js) chain with the
reference Python ap2.sdk. Reads the JSON emitted by sign-ts.mjs on argv[1]."""
import json, os, sys
SDK = os.environ.get("AP2_PYTHON_SDK")
sys.path.insert(0, SDK)
from jwcrypto.jwk import JWK
from ap2.sdk.mandate import MandateClient
from ap2.sdk.payment_mandate_chain import PaymentMandateChain

d = json.load(open(sys.argv[1]))
issuer = JWK.from_json(json.dumps(d["issuer_jwk"]))
payloads = MandateClient().verify(                       # raises on bad sig/aud/nonce/binding
    token=d["token"],
    key_or_provider=lambda _t: issuer,
    expected_aud=d["expected_aud"],
    expected_nonce=d["expected_nonce"],
)
chain = PaymentMandateChain.parse(payloads)
violations = chain.verify(
    expected_transaction_id=d["expected_transaction_id"],
    expected_open_checkout_hash=d["expected_open_checkout_hash"],
)
print("reference verified TS token: chain OK; violations =", violations)
print("  open.vct =", chain.open_mandate.vct, "| closed.vct =", chain.closed_mandate.vct,
      "| tx =", chain.closed_mandate.transaction_id,
      "| amount =", chain.closed_mandate.payment_amount.amount, chain.closed_mandate.payment_amount.currency)
assert violations == [], f"unexpected violations: {violations}"
print("REVERSE INTEROP: PASS")
