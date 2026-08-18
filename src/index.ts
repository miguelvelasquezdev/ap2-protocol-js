/**
 * ap2-protocol-js - TypeScript SDK for the Agent Payments Protocol (AP2).
 *
 * Curated public surface (subpath exports mirror these groups):
 * - mandate: create / present / verify mandates and chains
 * - sdjwt: the SD-JWT primitives (parse, disclosures, bindings, chain walk)
 * - schemas: Zod schemas + types generated from the canonical JSON Schemas
 * - receipts: create / sign / verify Checkout and Payment Receipts
 * - constraints: constraint evaluation + typed mandate chains
 */
export { Ap2Error, ok, err } from "./errors.ts";
export type { Ap2ErrorCode, Result } from "./errors.ts";

export {
  b64urlEncode,
  b64urlDecode,
  b64urlDecodeBytes,
  hashB64url,
  computeSha256B64url,
  createJwt,
  verifyJwt,
  decodeJwtHeader,
  assertEs256Jwk,
} from "./crypto/index.ts";
export type { Jwk, JwtHeader, SdAlg } from "./crypto/index.ts";

export {
  createMandate,
  presentMandate,
  verifyMandate,
  getClosedMandateJwt,
  canonicalChainSegment,
  splitChain,
} from "./mandate/index.ts";
export type {
  CreateMandateOptions,
  PresentMandateOptions,
  VerifyMandateOptions,
  VerifiedMandate,
} from "./mandate/index.ts";

export {
  parseToken,
  sdJwtOf,
  canonicalOf,
  computeSdHash,
  computeIssuerJwtHash,
  computeBinding,
  verifyBinding,
  createSdJwt,
  createDelegateRootSdJwt,
  createKbSdJwt,
  verifySdJwt,
  verifyKbSdJwt,
  verifyChain,
  x5cPublicKeyProvider,
  resolveDisclosures,
  decodeDisclosure,
  applyDisclosureSpec,
  randomSalt,
} from "./sdjwt/index.ts";
export type {
  ParsedToken,
  HashMode,
  DisclosureSpec,
  SaltSource,
  PublicKeyProvider,
  VerifyChainOptions,
} from "./sdjwt/index.ts";

export {
  computeReceiptReference,
  createPaymentReceipt,
  createCheckoutReceipt,
  signReceipt,
  verifyReceipt,
} from "./receipts/index.ts";
export type {
  CreatePaymentReceiptOptions,
  CreateCheckoutReceiptOptions,
  VerifyReceiptOptions,
} from "./receipts/index.ts";

export {
  merchantMatches,
  checkPresetPaymentClaims,
  checkPaymentConstraints,
  checkCheckoutConstraints,
  parsePaymentMandateChain,
  verifyPaymentMandateChain,
  verifyPaymentMandate,
  parseCheckoutMandateChain,
  verifyCheckoutMandateChain,
  extractParsedCheckoutObject,
} from "./constraints/index.ts";
export type {
  MandateContext,
  PaymentMandateChain,
  CheckoutMandateChain,
  VerifyPaymentMandateChainOptions,
  VerifyPaymentMandateOptions,
  VerifiedPaymentMandate,
  VerifyCheckoutMandateChainOptions,
} from "./constraints/index.ts";

export {
  VCT,
  OpenPaymentMandateSchema,
  PaymentMandateSchema,
  OpenCheckoutMandateSchema,
  CheckoutMandateSchema,
  PaymentReceiptSchema,
  CheckoutReceiptSchema,
  MerchantSchema,
  AmountSchema,
  PaymentInstrumentSchema,
  PISPSchema,
  ItemSchema,
  CheckoutSchema,
} from "./schemas/index.ts";
export type {
  Vct,
  PaymentConstraint,
  CheckoutConstraint,
  OpenPaymentMandate,
  PaymentMandate,
  OpenCheckoutMandate,
  CheckoutMandate,
  PaymentReceipt,
  PaymentReceiptSuccess,
  PaymentReceiptError,
  CheckoutReceipt,
  CheckoutReceiptSuccess,
  CheckoutReceiptError,
  Merchant,
  Amount,
  PaymentInstrument,
  PISP,
  Item,
  Checkout,
  LineItem,
} from "./schemas/index.ts";
