/**
 * AP2 in 60 seconds — a narrated walkthrough of one purchase.
 *
 *   pnpm ap2:walkthrough
 *
 * No API keys, no servers, no LLM. It runs the SAME mandate code the agents use
 * (src/common/ap2/mandates.ts) and prints what happens at each step, then shows
 * the attacks that a verifier rejects. Read the output next to that file and you
 * will understand AP2's core idea.
 */
import {
  createUserAuthorization,
  verifyUserAuthorization,
} from "../common/ap2/mandates.js";
import type { CartMandate } from "../common/types/cart-mandate.js";
import type { PaymentMandate } from "../common/types/payment-mandate.js";

const MERCHANT = "Tennis Warehouse";
const PRICE = 249.99;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

function step(n: number, title: string) {
  console.log(`\n${bold(`${n}. ${title}`)}`);
}

const cartMandate = {
  contents: {
    id: "cart_123",
    merchantName: MERCHANT,
    paymentRequest: {
      details: {
        id: "order_123",
        displayItems: [
          { label: "Wilson Pro Staff 97", amount: { currency: "USD", value: PRICE } },
        ],
        total: { label: "Total", amount: { currency: "USD", value: PRICE } },
      },
      methodData: [{ supportedMethods: "CARD" }],
    },
  },
} as unknown as CartMandate;

function contentsFor(value: number, id = "pm_demo_1") {
  return {
    paymentMandateId: id,
    paymentDetailsId: "order_123",
    paymentDetailsTotal: { label: "Total", amount: { currency: "USD", value } },
    paymentResponse: { requestId: "order_123", methodName: "CARD", details: { token: "tok_demo" } },
    merchantAgent: MERCHANT,
    timestamp: new Date().toISOString(),
  } as unknown as PaymentMandate["paymentMandateContents"];
}

async function main() {
  console.log(bold("\n━━━ AP2 walkthrough — one purchase, verified ━━━"));
  console.log(
    dim("The shopper wants a tennis racquet. An AI agent will buy it for them.\n" +
      "The merchant and the payment processor do NOT trust the agent."),
  );

  step(1, "The user approves a cart");
  console.log(`   ${MERCHANT} — Wilson Pro Staff 97 — ${cyan(`$${PRICE} USD`)}`);

  step(2, "The wallet mints the OPEN mandate, the agent presents the CLOSED one");
  const contents = contentsFor(PRICE);
  const auth = await createUserAuthorization({ cartMandate, paymentMandateContents: contents });
  const bundle = JSON.parse(auth) as { mandate: string; checkoutJwt: string };
  const hops = bundle.mandate.split("~~");
  console.log(dim(`   chain has ${hops.length} segments joined by "~~" (open mandate, then the key-bound purchase)`));
  console.log(dim(`   presentation is ${bundle.mandate.length} chars; here are the first 80:`));
  console.log(dim(`   ${bundle.mandate.slice(0, 80)}…`));
  console.log(
    dim("   the OPEN mandate carries the constraints the wallet signed:\n" +
      "     payment.reference     → this exact checkout\n" +
      `     payment.amount_range  → exactly ${PRICE} USD\n` +
      `     payment.allowed_payees → only ${MERCHANT}`),
  );

  step(3, "The payment processor verifies before moving money");
  const ok = await verifyUserAuthorization(auth, contents);
  console.log(
    ok.valid
      ? `   ${green("VERIFIED")} — authorized ${ok.authorized?.amountMinor} (minor units) ${ok.authorized?.currency} to ${ok.authorized?.payee}`
      : `   ${red("DENIED")} — ${ok.errors.join("; ")}`,
  );
  console.log(dim("   one call checked: wallet signature, agent key-binding, aud+nonce, expiry, AND the constraints."));

  step(4, "Now the things the agent CANNOT do");
  const attacks: Array<[string, () => Promise<{ valid: boolean; errors: string[] }>]> = [
    [
      "charge more than the user approved ($999.99)",
      () => verifyUserAuthorization(auth, { ...contentsFor(999.99), paymentMandateId: contents.paymentMandateId }),
    ],
    [
      "replay this mandate at a different verifier",
      () => verifyUserAuthorization(auth, contents, "http://evil.example"),
    ],
    [
      "reuse this mandate for a second purchase",
      () => verifyUserAuthorization(auth, { ...contents, paymentMandateId: "pm_demo_2" }),
    ],
    [
      "tamper with the signed chain",
      () =>
        verifyUserAuthorization(
          JSON.stringify({ ...bundle, mandate: bundle.mandate.slice(0, -3) + "AAA" }),
          contents,
        ),
    ],
  ];

  for (const [label, run] of attacks) {
    const r = await run();
    const verdict = r.valid ? red("ALLOWED (bug!)") : green("REJECTED");
    console.log(`   ${verdict}  ${label}`);
    if (!r.valid && r.errors[0]) console.log(dim(`             ↳ ${r.errors[0]}`));
  }

  console.log(
    `\n${bold("That is AP2.")} The agent is free to be as smart — or as wrong — as it likes.\n` +
      dim("What it spends is bounded by a signature the user made, and checked by someone who\n" +
        "does not trust it. Code: src/common/ap2/mandates.ts · SDK: ap2-protocol-js\n" +
        "Want the full multi-agent version with a chat UI? See the README (needs a Gemini key).\n"),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
