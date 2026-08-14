/**
 * Layer 1 issuer credential for the Verifiable Intent layer.
 *
 * In production this SD-JWT is minted by the credentials provider and
 * delivered over A2A; for the demo it is issued locally with the issuer
 * dev key from `.vi-keys.json`.
 */
import {
  IssuerCredential,
  createLayer1,
  type SdJwt,
} from "verifiable-intent-js";
import { getViKeys } from "./keys.js";

export const VI_ISSUER_URL = "https://credentials-provider.ap2.example";
export const SHOPPING_AGENT_URL = "http://localhost:8001";

/** Issue an L1 credential binding the demo user's device key. */
export async function issueL1ForUser(): Promise<SdJwt> {
  const keys = await getViKeys();
  const now = Math.floor(Date.now() / 1000);
  const credential = new IssuerCredential({
    iss: VI_ISSUER_URL,
    sub: "ap2-demo-user-001",
    iat: now,
    exp: now + 86400,
    aud: SHOPPING_AGENT_URL,
    cnfJwk: keys.user.publicKey,
    email: "shopper@example.com",
    panLastFour: "1234",
    scheme: "Mastercard",
  });
  return createLayer1(credential, keys.issuer.privateKey);
}
