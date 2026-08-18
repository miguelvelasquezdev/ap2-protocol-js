// A runnable end-to-end AP2 payment-mandate example: generate keys, issue an
// open mandate, present a closed one, and verify the presentation — including
// the over-budget case that the safe verifyPaymentMandate denies.
//
//   npm install ap2-protocol-js
//   node verify-payment-mandate.mjs
import { createMandate, presentMandate, verifyPaymentMandate } from "ap2-protocol-js";

const subtle = crypto.subtle;
async function keypair(kid) {
  const p = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    pub: { ...(await subtle.exportKey("jwk", p.publicKey)), kid, alg: "ES256" },
    priv: { ...(await subtle.exportKey("jwk", p.privateKey)), kid, alg: "ES256" },
  };
}

const issuer = await keypair("issuer-1"); // a credentials provider / user wallet
const agent = await keypair("agent-1"); // the shopping agent (holder)
const AUD = "merchant.example";
const NONCE = crypto.randomUUID();
const HASH = "checkout-hash-xyz";

async function chainFor(amount) {
  const open = await createMandate({
    payload: {
      vct: "mandate.payment.open.1",
      constraints: [
        { type: "payment.reference", conditional_transaction_id: HASH },
        { type: "payment.amount_range", currency: "USD", min: 100, max: 5000 },
      ],
      cnf: { jwk: { kty: agent.pub.kty, crv: agent.pub.crv, x: agent.pub.x, y: agent.pub.y, kid: agent.pub.kid } },
    },
    issuerKey: issuer.priv,
  });
  return presentMandate({
    holderKey: agent.priv,
    mandateToken: open,
    payload: {
      vct: "mandate.payment.1",
      transaction_id: "txn-1",
      payee: { id: "m-1", name: "Acme", website: "https://acme.example" },
      payment_amount: { currency: "USD", amount },
      payment_instrument: { id: "pi-1", type: "CARD" },
    },
    aud: AUD,
    nonce: NONCE,
  });
}

const opts = {
  resolveKey: () => issuer.pub,
  expectedAud: AUD,
  expectedNonce: NONCE,
  expectedOpenCheckoutHash: HASH,
};

const inRange = await verifyPaymentMandate({ token: await chainFor(2999), ...opts });
console.log("in-range ($29.99):     ", inRange.ok ? "TRUSTED" : `DENIED (${inRange.error.code})`);

const overBudget = await verifyPaymentMandate({ token: await chainFor(999999), ...opts });
console.log("over-budget ($9999.99):", overBudget.ok ? "TRUSTED (!!)" : `DENIED (${overBudget.error.code})`);

if (inRange.ok && !overBudget.ok) {
  console.log("\nverifyPaymentMandate enforces both the crypto chain and the constraints.");
}
