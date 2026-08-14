/**
 * W3C Verifiable Credentials module for the AP2 multi-agent system.
 *
 * Provides VC issuance, verification, and presentation creation
 * using Ed25519Signature2020 signatures.
 *
 * Usage:
 *   import { initKeyManager, issuePaymentCredential, verifyCredential } from '../vc/index.js';
 *
 *   // At startup:
 *   await initKeyManager();
 *
 *   // Issue a credential:
 *   const vc = await issuePaymentCredential({ paymentMethod: { ... } });
 *
 *   // Verify a credential:
 *   const result = await verifyCredential(vc);
 */

export { initKeyManager, getKeyManager, exportKeyPair, resetKeyManager } from './key-manager.js';

export {
  issuePaymentCredential,
  verifyCredential,
  verifyAndExtractSubject,
  createPresentation,
  verifyPresentation,
} from './credentials.js';

export type {
  IssuePaymentCredentialOptions,
} from './credentials.js';

export {
  documentLoader,
  registerDocument,
  unregisterDocument,
  clearDocuments,
} from './document-loader.js';

export { AP2_CONTEXT_URL } from './ap2-context.js';

export type {
  VerifiableCredential,
  VerifiablePresentation,
  VerifyCredentialResult,
  VerifyPresentationResult,
  DocumentLoader,
} from './types.js';
