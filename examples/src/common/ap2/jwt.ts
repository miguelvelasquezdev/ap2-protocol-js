/**
 * Minimal ES256 JWT signing for the merchant's checkout JWT.
 *
 * AP2 mandates are SD-JWTs handled by `ap2-protocol-js`; the checkout JWT is a
 * plain JWS, so this sample signs it with WebCrypto directly rather than adding
 * a dependency. Demo-grade on purpose: no key management, no `kid` resolution.
 */
import { webcrypto } from "node:crypto";
import type { Jwk } from "ap2-protocol-js";

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const encodeJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)));

export type Signer = (data: Uint8Array) => Promise<Uint8Array>;

/** Build an ES256 signer from a private JWK. */
export async function makeSigner(privateKey: Jwk): Promise<Signer> {
  const key = await webcrypto.subtle.importKey(
    "jwk",
    privateKey as unknown as JsonWebKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return async (data) => {
    const sig = await webcrypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(data),
    );
    return new Uint8Array(sig);
  };
}

/** Encode and sign a compact JWS (JWT). */
export async function jwtEncode(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  sign: Signer,
): Promise<string> {
  const signingInput = `${encodeJson(header)}.${encodeJson(payload)}`;
  const signature = await sign(new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64url(signature)}`;
}
