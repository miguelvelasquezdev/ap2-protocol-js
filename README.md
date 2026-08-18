# ap2-protocol-js

`ap2-protocol-js` is a TypeScript implementation of the
[Agent Payments Protocol (AP2)](https://ap2-protocol.org): create, present, and
verify mandates (SD-JWT delegation chains), issue and verify receipts, and
evaluate mandate constraints. TypeScript-native, framework-agnostic, with only
two runtime dependencies (`jose` + `zod`).

> **Independent & unofficial (pre-1.0).** This is my own implementation
> ([@miguelvelasquezdev](https://github.com/miguelvelasquezdev)) of Google's Agent
> Payments Protocol, written by following the official **AP2 specification** and
> the underlying **SD-JWT specifications** (IETF SD-JWT). It is **not** an official
> [Google](https://github.com/google-agentic-commerce/AP2) release and is **not**
> affiliated with or endorsed by Google; any errors are my own. APIs may change and
> it has not been independently audited (see [SECURITY.md](./SECURITY.md)). See
> [`NOTICE`](./NOTICE) for attribution.
>
> _Built with AI assistance (Claude) and reviewed/validated by me, a payments
> software engineer (@yuno)._

It covers the mandate lifecycle the reference sample flows exercise
(human-not-present, cards and x402). Runnable VI-based examples live in
[`examples/`](./examples). See "Roadmap" for what is staged for v1.1.

## Design

- **WebCrypto + jose only.** Runs on Node >= 20, browsers, and edge runtimes.
  No `node:crypto`, no `Buffer`. SD-JWT serialization is hand-rolled for
  byte-level control; JOSE (ES256, JWK import) uses `jose`.
- **Wire types are generated,** never hand-maintained: `scripts/generate-schemas.mjs`
  turns the canonical JSON Schemas (`code/sdk/schemas`) into Zod v4 schemas +
  inferred types. An Ajv oracle test keeps the codegen honest against the spec.
- **Fail-closed, typed results.** Verification returns a discriminated
  `Result<T>` (`{ ok: true, value } | { ok: false, error }`); a denied
  credential is a value, not an exception. Issuance/presentation throws a typed
  `Ap2Error` with a machine-readable `code`. No string-matching on messages.
- **N-hop chains.** The chain walk verifies hop 0 under a resolved issuer key
  and every later hop under the previous hop's `cnf.jwk`, supports both
  `sd_hash` and `issuer_jwt_hash` binding modes (the redaction-privacy
  property), and enforces `aud`/`nonce` on the terminal hop.

## Layout

| Path | What |
|------|------|
| `src/crypto` | base64url, hashing by `_sd_alg`, ES256 JWTs, JWK guards |
| `src/sdjwt` | `ParsedToken`, disclosures, SD-JWT / KB-SD-JWT, `verifyChain` |
| `src/mandate` | `createMandate` / `presentMandate` / `verifyMandate` |
| `src/receipts` | create / sign / verify Payment and Checkout receipts |
| `src/constraints` | constraint evaluation + typed mandate chains |
| `src/schemas` | generated Zod schemas + types (curated re-export) |

Everything is re-exported from the package root, so a single
`import { ... } from "ap2-protocol-js"` reaches every layer.

## Usage

### Verify (merchant / PSP side)

Use **`verifyPaymentMandate`**. It fails closed on BOTH the delegation chain
(signatures, key binding, aud/nonce) AND the mandate's own constraints (amount
range, payee, checkout binding, budget), so `if (result.ok)` is a safe
authorization gate.

```ts
import { verifyPaymentMandate } from "ap2-protocol-js";

const result = await verifyPaymentMandate({
  token: chain,                        // the ~~-joined SD-JWT presentation from the agent
  resolveKey: () => issuerPublicJwk,   // resolve the ROOT issuer's public JWK out of band
  expectedAud: "merchant.example",     // this verifier's identity  (replay defense)
  expectedNonce: nonce,                // the fresh nonce it issued  (replay defense)
  expectedOpenCheckoutHash: hash,      // binds the open mandate to this checkout
});

if (result.ok) {
  const { closedMandate } = result.value.chain;
  closedMandate.payment_amount; // { currency: "USD", amount: 2999 } — constraints already enforced
  closedMandate.payee;          // the authorized merchant
} else {
  result.error.code; // "signature_invalid" | "nonce_mismatch" | "constraints_violated" | ...
}
```

> **Do not gate on `verifyMandate` alone.** `verifyMandate` proves the chain is
> cryptographically authentic but does NOT evaluate constraints, so an
> over-budget or wrong-payee mandate would still return `ok`. Use
> `verifyPaymentMandate` above, or run the three-step path yourself:
> `verifyMandate` → `parsePaymentMandateChain` → `verifyPaymentMandateChain`.
> The key option is `resolveKey` (chain) or `key` (single token) — not
> `issuerKey`; an unknown option is ignored and yields a fail-closed
> `missing_key` deny.

### Issue + present (agent / credentials-provider side)

```ts
import { createMandate, presentMandate } from "ap2-protocol-js";

// Open mandate: the standing authorization, bound to the agent's key (cnf) and
// capped by an amount range. AP2 requires a payment.reference constraint.
const open = await createMandate({
  payload: {
    vct: "mandate.payment.open.1",
    constraints: [
      { type: "payment.reference", conditional_transaction_id: hash },
      { type: "payment.amount_range", currency: "USD", min: 100, max: 50000 },
    ],
    cnf: { jwk: { kty: agentPub.kty, crv: agentPub.crv, x: agentPub.x, y: agentPub.y, kid: agentPub.kid } },
  },
  issuerKey: issuerPrivateJwk,
});

// Closed mandate: the agent presents the exact purchase, key-bound to aud+nonce.
const chain = await presentMandate({
  holderKey: agentPrivateJwk,
  mandateToken: open,
  payload: {
    vct: "mandate.payment.1",
    transaction_id: "txn-1",
    payee: { id: "m-1", name: "Acme", website: "https://acme.example" },
    payment_amount: { currency: "USD", amount: 2999 },
    payment_instrument: { id: "pi-1", type: "CARD" },
  },
  aud: "merchant.example",
  nonce,
});
```

A full runnable version (keygen → issue → present → verify, plus the over-budget
deny) is in [`example/verify-payment-mandate.mjs`](./example/verify-payment-mandate.mjs).

## Scripts

```sh
npm run generate    # regenerate src/schemas/generated.ts from the JSON Schemas
npm test            # vitest behavior + oracle + cross-impl vector suites
npm run typecheck   # tsc --noEmit at strict settings
```

## Roadmap (v1.1)

- x5c trusted-root public-key provider (base64url-DER, pairwise chain verify,
  trusted-root anchoring, `kid` fallback). Currently a typed
  `x5c_not_supported` stub.
- Line-item constraint matching (max-flow: Dinic + Edmonds-Karp, wildcards).
  Currently a typed not-yet-supported violation.
- Disclosure metadata derived from the schema `x-selectively-disclosable-*`
  annotations, and decoy claims.
- The DPC / human-present flow.
- ~~Cross-impl vectors generated from the reference Python SDK.~~ **Done** —
  `scripts/generate-fixtures.py` drives the reference `ap2.sdk` and
  `test/vectors.test.ts` verifies them here (both directions; see
  `scripts/interop/`).
