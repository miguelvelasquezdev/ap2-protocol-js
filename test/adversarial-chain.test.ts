import { describe, expect, it } from "vitest";
import {
  createMandate,
  presentMandate,
  splitChain,
  verifyMandate,
  type Jwk,
  type PublicKeyProvider,
} from "../src/index.ts";
import { cnf, counterSalts, FROZEN_NOW, makeKeypair, samplePaymentMandate } from "./fixtures.ts";

/** Build a chain of `depth` intermediate delegations ending in a closed
 * payment mandate. Returns the chain and the root issuer key. */
async function buildDeepChain(depth: number) {
  const issuer = await makeKeypair("issuer");
  const keys: Awaited<ReturnType<typeof makeKeypair>>[] = [];
  for (let i = 0; i <= depth; i++) keys.push(await makeKeypair(`k${i}`));

  let token = await createMandate({
    payload: {
      vct: "mandate.payment.open.1",
      constraints: [{ type: "payment.reference", conditional_transaction_id: "chk" }],
      cnf: cnf(keys[0]!.publicJwk),
    },
    issuerKey: issuer.privateJwk,
    saltSource: counterSalts(),
  });

  // Intermediate hops (depth - 2 of them): each delegates to the next key.
  for (let i = 0; i < depth - 2; i++) {
    token = await presentMandate({
      holderKey: keys[i]!.privateJwk,
      mandateToken: token,
      payload: {
        vct: "mandate.payment.open.1",
        constraints: [{ type: "payment.reference", conditional_transaction_id: "chk" }],
        cnf: cnf(keys[i + 1]!.publicJwk),
      },
      aud: "cp",
      nonce: `n${i}`,
      saltSource: counterSalts(),
      nowSeconds: FROZEN_NOW,
    });
  }

  // Terminal hop: the last delegated key presents the closed payment mandate.
  token = await presentMandate({
    holderKey: keys[depth - 2]!.privateJwk,
    mandateToken: token,
    payload: samplePaymentMandate(),
    aud: "cp",
    nonce: "final",
    saltSource: counterSalts(),
    nowSeconds: FROZEN_NOW,
  });

  return { issuer, chain: token };
}

describe("deep chains", () => {
  it("verifies a 4-hop chain and extends payloads per hop", async () => {
    const { issuer, chain } = await buildDeepChain(4);
    expect(splitChain(chain).length).toBe(4);
    const result = await verifyMandate({
      token: chain,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "final",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "chain") {
      expect(result.value.payloads.length).toBe(4);
      expect(result.value.payloads.at(-1)?.["transaction_id"]).toBe("txn-abc");
    }
  });

  it("supports an async PublicKeyProvider (registry lookup)", async () => {
    const { issuer, chain } = await buildDeepChain(3);
    const asyncResolve: PublicKeyProvider = async (): Promise<Jwk> => {
      await Promise.resolve();
      return issuer.publicJwk;
    };
    const result = await verifyMandate({
      token: chain,
      resolveKey: asyncResolve,
      expectedAud: "cp",
      expectedNonce: "final",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(true);
  });
});

describe("chain tampering resistance", () => {
  it("rejects a naive truncation as malformed (stripped final segment)", async () => {
    const { issuer, chain } = await buildDeepChain(3);
    // Dropping the last ~~-segment leaves a segment whose trailing ~ was
    // stripped by the join, so it is not a well-formed final SD-JWT.
    const naive = chain.split("~~").slice(0, -1).join("~~");
    const result = await verifyMandate({
      token: naive,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "final",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("malformed_token");
  });

  it("nonce binding prevents a WELL-FORMED truncation of the terminal hop", async () => {
    const { issuer, chain } = await buildDeepChain(3);
    // A careful attacker restores the trailing ~ so the shortened chain parses;
    // the verifier still demands the nonce IT issued for the terminal hop, and
    // the (now-terminal) intermediate hop carries a different nonce.
    const wellFormed = `${chain.split("~~").slice(0, -1).join("~~")}~`;
    const result = await verifyMandate({
      token: wellFormed,
      resolveKey: () => issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "final",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("nonce_mismatch");
  });

  it("rejects a middle hop re-pointed to an attacker key", async () => {
    // Build two independent chains under the same issuer; splice the terminal
    // hop of one onto the intermediate of the other. The binding hash will not
    // match, so it must fail.
    const a = await buildDeepChain(3);
    const b = await buildDeepChain(3);
    const aSegs = a.chain.split("~~");
    const bSegs = b.chain.split("~~");
    const spliced = [...aSegs.slice(0, -1), bSegs.at(-1)].join("~~");
    const result = await verifyMandate({
      token: spliced,
      resolveKey: () => a.issuer.publicJwk,
      expectedAud: "cp",
      expectedNonce: "final",
      nowSeconds: FROZEN_NOW,
    });
    expect(result.ok).toBe(false);
    // Either the binding hash or the cnf key mismatch stops it.
    if (!result.ok) {
      expect(["binding_mismatch", "signature_invalid"]).toContain(result.error.code);
    }
  });
});
