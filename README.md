# ap2-js

`ap2-js` is a TypeScript implementation of the
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

Subpath exports mirror these: `ap2-js/mandate`, `/sdjwt`,
`/schemas`, `/receipts`, `/constraints`.

## Usage

```ts
import { createMandate, presentMandate, verifyMandate } from "ap2-js";

// Issue an open mandate that delegates to a holder key.
const open = await createMandate({ payload: openMandate, issuerKey });

// The holder presents a key-bound closed mandate.
const chain = await presentMandate({
  holderKey, mandateToken: open, payload: closedMandate, aud: "merchant", nonce,
});

// A verifier checks the chain, resolving the root issuer key out of band.
const result = await verifyMandate({
  token: chain, resolveKey: () => issuerPublicJwk,
  expectedAud: "merchant", expectedNonce: nonce,
});
if (result.ok) {
  // result.value.payloads: the effective payloads, extended per hop
}
```

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
- Cross-impl vectors generated from the reference Python SDK
  (`scripts/generate-fixtures.py`).
