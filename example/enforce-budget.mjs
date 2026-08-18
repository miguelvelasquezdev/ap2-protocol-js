// Enforce a spend budget across authorizations with MandateContext.
//
// The SDK evaluates the payment.budget constraint against the context you pass,
// but never persists it — YOU own the running total. In production the
// load -> verify -> commit cycle MUST be atomic per mandate scope (a stale
// counter double-spends under concurrency; see
// test/mandate-context-concurrency.test.ts). Here it is sequential for clarity.
//
//   npm install ap2-protocol-js && node enforce-budget.mjs
import { createMandate, presentMandate, verifyPaymentMandate } from "ap2-protocol-js";

const subtle = crypto.subtle;
async function keypair(kid) {
  const p = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  return {
    pub: { ...(await subtle.exportKey("jwk", p.publicKey)), kid, alg: "ES256" },
    priv: { ...(await subtle.exportKey("jwk", p.privateKey)), kid, alg: "ES256" },
  };
}

const wallet = await keypair("wallet-1"); // issues the open mandate
const agent = await keypair("agent-1"); // presents payments
const AUD = "merchant.example";
const HASH = "checkout-hash";
const BUDGET_MAJOR = 5; // a $5 budget (payment.budget.max is in MAJOR units)

const open = await createMandate({
  payload: {
    vct: "mandate.payment.open.1",
    constraints: [
      { type: "payment.reference", conditional_transaction_id: HASH },
      { type: "payment.budget", currency: "USD", max: BUDGET_MAJOR },
    ],
    cnf: { jwk: { kty: agent.pub.kty, crv: agent.pub.crv, x: agent.pub.x, y: agent.pub.y, kid: agent.pub.kid } },
  },
  issuerKey: wallet.priv,
});

function present(amountMinor, nonce, txid) {
  return presentMandate({
    holderKey: agent.priv,
    mandateToken: open,
    payload: {
      vct: "mandate.payment.1",
      transaction_id: txid,
      payee: { id: "m-1", name: "Acme", website: "https://acme.example" },
      payment_amount: { currency: "USD", amount: amountMinor },
      payment_instrument: { id: "pi-1", type: "CARD" },
    },
    aud: AUD,
    nonce,
  });
}

let totalAmount = 0; // persist this; make the commit atomic in production

async function authorize(amountMinor, nonce, txid) {
  const token = await present(amountMinor, nonce, txid);
  const result = await verifyPaymentMandate({
    token,
    resolveKey: () => wallet.pub,
    expectedAud: AUD,
    expectedNonce: nonce,
    expectedOpenCheckoutHash: HASH,
    context: { totalAmount }, // the SDK checks the budget against this
  });
  if (result.ok) {
    totalAmount += amountMinor; // commit (atomically, in production)
    return "AUTHORIZED";
  }
  return `DECLINED (${result.error.code})`;
}

console.log("$2 payment #1:", await authorize(200, "n1", "tx1"));
console.log("$2 payment #2:", await authorize(200, "n2", "tx2"));
console.log("$2 payment #3:", await authorize(200, "n3", "tx3"));
console.log(`spent ${totalAmount} of ${BUDGET_MAJOR * 100} minor units`);
