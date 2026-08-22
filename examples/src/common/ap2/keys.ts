/**
 * Demo-grade ES256 keys for the AP2 mandate layer.
 *
 * Three keypairs, one per role in the AP2 trust model:
 *   - wallet   — issues the OPEN payment mandate (the user's authorization).
 *                Its PUBLIC key is what the payment processor verifies against.
 *   - agent    — the shopping agent's key. The open mandate is key-bound to it
 *                via `cnf`, so ONLY this agent can present a closed mandate.
 *   - merchant — signs the checkout JWT the mandate is bound to.
 *
 * They are generated on first use and persisted to `.ap2-keys.json` at the
 * sample root, because each role runs as its own process and they must agree on
 * the keys across runs. The file is gitignored. NEVER use these outside the demo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Jwk } from "ap2-protocol-js";

export interface Ap2KeyPair {
  privateKey: Jwk;
  publicKey: Jwk;
}

export interface Ap2Keys {
  wallet: Ap2KeyPair;
  agent: Ap2KeyPair;
  merchant: Ap2KeyPair;
}

const KEYS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.ap2-keys.json",
);

let cached: Ap2Keys | null = null;

async function generateEs256Key(kid: string): Promise<Ap2KeyPair> {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const privateKey = {
    ...((await webcrypto.subtle.exportKey("jwk", pair.privateKey)) as Jwk),
    kid,
    alg: "ES256",
  };
  const publicKey = {
    ...((await webcrypto.subtle.exportKey("jwk", pair.publicKey)) as Jwk),
    kid,
    alg: "ES256",
  };
  return { privateKey, publicKey };
}

export async function getAp2Keys(): Promise<Ap2Keys> {
  if (cached) return cached;
  if (existsSync(KEYS_PATH)) {
    cached = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as Ap2Keys;
    return cached;
  }
  const keys: Ap2Keys = {
    wallet: await generateEs256Key("ap2-demo-wallet-1"),
    agent: await generateEs256Key("ap2-demo-agent-1"),
    merchant: await generateEs256Key("ap2-demo-merchant-1"),
  };
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
  cached = keys;
  return keys;
}
