# ap2-js

JavaScript/TypeScript samples for the Agent Payments Protocol (AP2), built on
the [Agent Development Kit (ADK)](https://google.github.io/adk-docs/) and the
[A2A SDK](https://www.npmjs.com/package/@a2a-js/sdk).

## Available Scenarios

- **[Human-Present Card Payment](./src/scenarios/a2a/human-present/cards/README.md)**
    - Complete card payment flow with all four agents implemented in TypeScript.

See the [scenario README](./src/scenarios/a2a/human-present/cards/README.md)
for detailed setup and usage instructions.

## Why TypeScript for AP2 Agents?

TypeScript is a natural fit for AP2 agents that are deployed alongside web,
Node.js, or edge runtimes:

- **Type Safety**: Compile-time validation of protocol structures via Zod
  schemas mirrored from the AP2 reference types.
- **Ecosystem**: Direct access to the npm ecosystem and the `@a2a-js/sdk` and
  `@google/adk` packages.
- **Portability**: Run on any Node.js 20+ runtime, including serverless and
  container platforms.

## Project Structure

```text
ap2-js/
└── src/
    ├── roles/                  # Agent role implementations and entry points
    │   ├── shopping/           # Shopping Agent (root orchestrator)
    │   │   └── subagents/      # shopper, shipping-collector, payment-collector
    │   ├── merchant/           # Merchant Agent
    │   ├── credentials-provider/
    │   └── payment-processor/
    ├── common/                 # Shared modules used across roles
    │   ├── server/             # A2A server bootstrap, executor, middleware
    │   ├── utils/              # Message and artifact helpers
    │   ├── types/              # AP2 protocol object types
    │   ├── schemas/            # Zod schemas mirroring the protocol
    │   ├── vc/                 # W3C Verifiable Credential helpers
    │   ├── vi/                 # Verifiable Intent (SD-JWT delegation chain)
    │   ├── config/             # Session and runtime configuration
    │   └── constants/          # Shared constants
    ├── test/
    │   ├── e2e/                # End-to-end smoke tests
    │   └── vi/                 # Offline Verifiable Intent unit tests
    └── scenarios/
        └── a2a/
            └── human-present/
                └── cards/      # Card payment scenario
```

## Development

```sh
# Install dependencies
npm install

# Configure environment
cp .env.example .env
# fill in the required values in .env

# Type-check and build
npm run build

# Start all four agents plus the ADK web UI
npm run dev

# Run the e2e smoke tests against running agents
npm test

# Run only the offline Verifiable Intent unit tests (no agents needed)
npx vitest run src/test/vi
```

## Verifiable Intent layer

The sample integrates the [`@verifiable-intent/core`](../verifiable-intent)
SDK to make the user's authorization cryptographically verifiable instead of a
placeholder string:

- The shopping agent's `signMandatesOnUserDevice` tool builds an SD-JWT
  delegation chain: an **L1 issuer credential** (standing in for the
  credentials provider; bound to the user's device key) plus an **L2 immediate
  user mandate** over the final cart and payment values. The bundle is carried
  in the payment mandate's `userAuthorization` field as
  `JSON.stringify({ l1, l2 })` — no schema change.
- The payment processor's `initiatePayment` tool verifies the chain
  (`src/common/vi/verify.ts`) — signatures, L1↔L2 binding, expected audience
  and nonce, and the disclosed payment amount/currency — before raising any
  challenge or executing the payment, and fails the payment on mismatch.
- Keys are demo-grade: three ES256 keypairs are generated on first use and
  persisted to `.vi-keys.json` at the repo root (gitignored) so the issuing
  and verifying agents share them. Never use them outside the demo.

See `src/common/vi/` for the issuing/verification helpers and `src/test/vi/`
for offline unit tests.

See the scenario README for a full walkthrough.
