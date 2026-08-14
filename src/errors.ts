/**
 * Typed errors and result shapes. One failure channel per operation:
 * verification returns results (a denied credential is a normal value);
 * issuance/presentation throws Ap2Error (misuse is a programmer error).
 */

export type Ap2ErrorCode =
  | "malformed_token"
  | "unsupported_format"
  | "invalid_key"
  | "missing_key"
  | "signature_invalid"
  | "binding_mismatch"
  | "typ_invalid"
  | "cnf_missing"
  | "cnf_forbidden"
  | "aud_mismatch"
  | "nonce_mismatch"
  | "aud_nonce_required"
  | "expired"
  | "iat_invalid"
  | "payload_invalid"
  | "disclosure_invalid"
  | "x5c_not_supported"
  | "internal";

export class Ap2Error extends Error {
  readonly code: Ap2ErrorCode;
  constructor(code: Ap2ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "Ap2Error";
    this.code = code;
  }
}

/** Discriminated verification result. Fail-closed: read data only when ok. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: Ap2ErrorCode; readonly message: string } };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(code: Ap2ErrorCode, message: string): Result<T> {
  return { ok: false, error: { code, message } };
}
