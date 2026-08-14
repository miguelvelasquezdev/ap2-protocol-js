/**
 * Demo-grade development keys for the Verifiable Intent (VI) layer.
 *
 * Three ES256 keypairs are generated on first use and persisted to
 * `.vi-keys.json` at the repo root so that issuing and verifying agents
 * (separate processes in this sample) share the same keys across runs.
 * The file is gitignored; NEVER use these keys outside the demo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateEs256Key } from "@verifiable-intent/core";

export type ViKeyPair = Awaited<ReturnType<typeof generateEs256Key>>;

export interface ViKeys {
  /** L1 issuer — stands in for the credentials provider. */
  issuer: ViKeyPair;
  /** L2 signer — the shopper's device key, bound in L1 via cnf. */
  user: ViKeyPair;
  /** Signs the checkout JWT inside the L2 mandate. */
  merchant: ViKeyPair;
}

const KEYS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.vi-keys.json"
);

let cached: ViKeys | null = null;

export async function getViKeys(): Promise<ViKeys> {
  if (cached) return cached;
  if (existsSync(KEYS_PATH)) {
    cached = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as ViKeys;
    return cached;
  }
  const keys: ViKeys = {
    issuer: await generateEs256Key(),
    user: await generateEs256Key(),
    merchant: await generateEs256Key(),
  };
  writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2), { mode: 0o600 });
  cached = keys;
  return keys;
}
