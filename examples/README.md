# Try AP2

A runnable sample of the **Agent Payments Protocol (AP2)**: an AI agent buys
something on a user's behalf, and a merchant and payment processor **verify
cryptographically that the user really authorized it** — without trusting the
agent at all.

Built on [`ap2-protocol-js`](../) (the SDK in this repo), Google's
[ADK](https://google.github.io/adk-docs/) and the
[A2A SDK](https://www.npmjs.com/package/@a2a-js/sdk).

## 1. See it in 60 seconds (no API keys)

```sh
pnpm install
pnpm ap2:walkthrough
```

Prints one purchase being authorized and verified, then shows the attacks a
verifier rejects — over-charging, replay, tampering. No servers, no LLM, no keys.
It runs the exact same mandate code the agents use.

## 2. The whole thing: chat with a shopping agent

Four agents talking over A2A, driven by an LLM, with a chat UI:

```sh
cp .env.example .env    # add your Gemini API key
pnpm dev                # starts the 4 agents + ADK web UI on :3001
```

Open <http://localhost:3001>, pick the shopping agent, and say
*"I want a tennis racquet"*. It finds a product with the merchant, collects a
shipping address and payment method, asks you to approve, and only then does the
payment processor verify the mandate and charge.

**Use a seeded demo identity** — the credentials provider only knows a few
accounts, and the payment method has to match what the cart accepts (a CARD
cart cannot be paid with a PayPal-only account):

| email | has |
|---|---|
| `bugsbunny@gmail.com` | Amex cards, bank account, PayPal — **use this one** |
| `daffyduck@gmail.com` | bank account only |
| `elmerfudd@gmail.com` | PayPal only |

Pick the payment method by the exact alias the agent lists (e.g.
*"American Express ending in 4444"*). When the issuer asks for a verification
code, the demo OTP is `123`.

Get a Gemini key at [AI Studio](https://aistudio.google.com/apikey) (free tier
works).

## What AP2 actually does

An LLM agent can be wrong, jailbroken, or hostile. AP2 assumes exactly that: the
spec treats **every agent as a potential attacker**. So authorization does not
live in the agent — it lives in two signed mandates:

| | who signs it | what it says |
|---|---|---|
| **Open mandate** `mandate.payment.open.1` | the user's **wallet** | "I authorize a payment, bounded by these constraints", key-bound (`cnf`) to one specific agent |
| **Closed mandate** `mandate.payment.1` | the **agent** | "here is the actual purchase" — amount, payee, instrument — addressed to one verifier (`aud`) with a fresh `nonce` |

They are joined with `~~` into one presentation. The payment processor verifies
the whole thing in a single fail-closed call:

```ts
const result = await verifyPaymentMandate({
  token,                                  // the ~~-joined chain
  resolveKey: () => walletPublicKey,      // never a key from inside the token
  expectedAud, expectedNonce,             // replay defense
  expectedOpenCheckoutHash: checkoutHash, // recomputed, not trusted
});
if (result.ok) { /* safe to charge */ }
```

That one call checks the wallet signature, the agent key-binding, `aud`/`nonce`,
expiry **and** the constraints the wallet signed. So the agent cannot:

- charge more than the user approved (`payment.amount_range`)
- pay a different merchant (`payment.allowed_payees`)
- point the authorization at another cart (`payment.reference`, hash recomputed)
- replay it at another verifier or for a second purchase (`aud` + `nonce`)

**Start here:** [`src/common/ap2/mandates.ts`](./src/common/ap2/mandates.ts) —
the whole protocol layer, ~200 commented lines. Everything else is agent
plumbing.

## Layout

```text
src/
├── common/ap2/          ← the AP2 layer. Read this one.
│   ├── mandates.ts        mint the chain + verify it
│   ├── keys.ts            demo ES256 keys (wallet / agent / merchant)
│   └── jwt.ts             the merchant's checkout JWT
├── roles/               ← the four agents
│   ├── shopping/          orchestrator + subagents (shopper, shipping, payment)
│   ├── merchant/          catalog, signs the cart
│   ├── credentials-provider/  the user's payment methods
│   └── payment-processor/     VERIFIES the mandate, then charges
├── scenarios/
│   ├── ap2-walkthrough.ts   the no-keys narrated demo
│   └── a2a/human-present/   the full A2A scenario
└── test/ap2/            ← the flow + the attacks, as tests
```

## Honest limits

This is a **sample**, not a production deployment:

- All keys are demo keys generated into a gitignored `.ap2-keys.json`. In the
  real model the wallet key lives on the **user's device** — that is what makes
  the authorization theirs. Here it does not, so this proves the protocol, not
  key custody.
- The merchant, credentials provider and payment processor are simulations; no
  money moves.
- Key discovery is a local lookup. In production you resolve the wallet key from
  a JWKS/registry by `kid`, never from the token.

For production concerns — key discovery, double-spend, replay stores, resource
limits — see [SECURITY.md](../SECURITY.md).

## Tests

```sh
pnpm test                      # the AP2 flow + attack cases
pnpm exec vitest run src/test/ap2
```

The `src/test/e2e` suite needs the four agents running (`pnpm dev`) and a Gemini
key; it fails offline by design.
