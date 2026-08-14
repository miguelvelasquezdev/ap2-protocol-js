/** Shared test fixtures: deterministic keys, salts, and mandate builders. */
import { exportJWK, generateKeyPair } from "jose";
import type { Jwk } from "../src/index.ts";

export interface Keypair {
  readonly privateJwk: Jwk;
  readonly publicJwk: Jwk;
}

export async function makeKeypair(kid: string): Promise<Keypair> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "ES256" } as Jwk;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "ES256" } as Jwk;
  return { publicJwk, privateJwk };
}

/** A deterministic salt source: s0, s1, s2, ... (tests only). */
export function counterSalts(): () => string {
  let i = 0;
  return () => `s${i++}`;
}

export const FROZEN_NOW = Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000);

export function cnf(publicJwk: Jwk): Record<string, unknown> {
  return { jwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y, kid: publicJwk.kid } };
}

export function samplePaymentMandate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vct: "mandate.payment.1",
    transaction_id: "txn-abc",
    payee: { id: "m-1", name: "Acme", website: "https://acme.test" },
    payment_amount: { currency: "USD", amount: 27999 },
    payment_instrument: { id: "pi-1", type: "CARD" },
    ...overrides,
  };
}
