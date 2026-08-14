import { describe, expect, it } from "vitest";
import {
  createMandate,
  getClosedMandateJwt,
  presentMandate,
  verifyMandate,
  type Jwk,
  type PublicKeyProvider,
} from "../src/index.ts";
import { cnf, counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/** A three-hop chain: issuer -> agent (intermediate) -> holder (terminal). */
async function buildThreeHopChain() {
  const issuer = await makeKeypair("issuer");
  const agent = await makeKeypair("agent");
  const holder = await makeKeypair("holder");

  // Hop 0: the open mandate names the agent's key in cnf.
  const openMandate = await createMandate({
    payload: {
      vct: "mandate.payment.open.1",
      constraints: [{ type: "payment.reference", conditional_transaction_id: "chk-1" }],
      cnf: cnf(agent.publicJwk),
    },
    issuerKey: issuer.privateJwk,
    saltSource: counterSalts(),
  });

  // Hop 1: agent presents an intermediate hop that delegates to the holder.
  const intermediate = await presentMandate({
    holderKey: agent.privateJwk,
    mandateToken: openMandate,
    payload: {
      vct: "mandate.payment.open.1",
      constraints: [{ type: "payment.reference", conditional_transaction_id: "chk-1" }],
      cnf: cnf(holder.publicJwk),
    },
    aud: "credential-provider",
    nonce: "n-1",
    saltSource: counterSalts(),
    nowSeconds: FROZEN_NOW,
  });

  // Hop 2: holder presents the terminal closed payment mandate.
  const chain = await presentMandate({
    holderKey: holder.privateJwk,
    mandateToken: intermediate,
    payload: samplePaymentMandate(),
    aud: "credential-provider",
    nonce: "n-2",
    saltSource: counterSalts(),
    nowSeconds: FROZEN_NOW,
  });

  return { issuer, agent, holder, openMandate, intermediate, chain };
}

describe("N-hop chain", () => {
  it("verifies a three-hop chain and extends ~~ per hop", async () => {
    const { issuer, openMandate, intermediate, chain } = await buildThreeHopChain();
    expect((openMandate.match(/~~/g) ?? []).length).toBe(0);
    expect((intermediate.match(/~~/g) ?? []).length).toBe(1);
    expect((chain.match(/~~/g) ?? []).length).toBe(2);

    const resolveKey: PublicKeyProvider = () => issuer.publicJwk;
    const result = await verifyMandate({
      token: chain,
      resolveKey,
      expectedAud: "credential-provider",
      expectedNonce: "n-2",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "chain") {
      // payloads EXTEND: 3 hops -> 3 effective payloads.
      expect(result.value.payloads.length).toBe(3);
      expect(result.value.payloads[2]?.["transaction_id"]).toBe("txn-abc");
    }
  });

  it("getClosedMandateJwt is stable across chain depth", async () => {
    const { chain } = await buildThreeHopChain();
    const closed = getClosedMandateJwt(chain);
    // It is the issuer JWT of the last segment (3-dot JWT).
    expect(closed.split(".").length).toBe(3);
  });

  it("rejects a chain missing aud/nonce at the terminal hop", async () => {
    const { issuer, chain } = await buildThreeHopChain();
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("aud_nonce_required");
  });

  it("fails when a hop is signed by the wrong holder key", async () => {
    const { issuer, agent, openMandate } = await buildThreeHopChain();
    const wrong = await makeKeypair("wrong");
    // Present the terminal hop with a key that is NOT the agent's cnf key.
    const badChain = await presentMandate({
      holderKey: wrong.privateJwk,
      mandateToken: openMandate,
      payload: samplePaymentMandate(),
      aud: "credential-provider",
      nonce: "n-2",
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
    void agent;
    const result = await verifyMandate({
      token: badChain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "credential-provider",
      expectedNonce: "n-2",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("signature_invalid");
  });
});

describe("temporal checks", () => {
  it("rejects an expired terminal hop", async () => {
    const issuer = await makeKeypair("issuer");
    const holder = await makeKeypair("holder");
    const open = await createMandate({
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.reference", conditional_transaction_id: "chk-1" }],
        cnf: cnf(holder.publicJwk),
      },
      issuerKey: issuer.privateJwk,
      saltSource: counterSalts(),
    });
    const chain = await presentMandate({
      holderKey: holder.privateJwk,
      mandateToken: open,
      payload: samplePaymentMandate({ exp: FROZEN_NOW - 10_000 }),
      aud: "a",
      nonce: "n",
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW - 20_000,
    });
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "a",
      expectedNonce: "n",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("expired");
  });
});
