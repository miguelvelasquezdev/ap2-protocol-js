/**
 * AP2 wire types: Zod v4 schemas + inferred types generated from the
 * canonical JSON Schemas (code/sdk/schemas). Curated surface; the generated
 * file is an implementation detail.
 */
export {
  // Mandates
  OpenPaymentMandateSchema,
  PaymentMandateSchema,
  OpenCheckoutMandateSchema,
  CheckoutMandateSchema,
  // Receipts (status-discriminated unions + branches)
  PaymentReceiptSchema,
  PaymentReceiptSuccessSchema,
  PaymentReceiptErrorSchema,
  CheckoutReceiptSchema,
  CheckoutReceiptSuccessSchema,
  CheckoutReceiptErrorSchema,
  // Constraints
  AgentRecurrenceSchema,
  AllowedPayeesSchema,
  AllowedPaymentInstrumentsSchema,
  AllowedPispsSchema,
  AmountRangeSchema,
  BudgetSchema,
  ExecutionDateSchema,
  PaymentReferenceSchema,
  AllowedMerchantsSchema,
  LineItemsSchema,
  LineItemRequirementsSchema,
  // Shared types
  MerchantSchema,
  AmountSchema,
  PaymentInstrumentSchema,
  PISPSchema,
  ItemSchema,
  CheckoutSchema,
  LineItemSchema,
  TotalSchema,
  BuyerSchema,
  LinkSchema,
} from "./generated.ts";
export type {
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
  AgentRecurrence,
  AllowedPayees,
  AllowedPaymentInstruments,
  AllowedPisps,
  AmountRange,
  Budget,
  ExecutionDate,
  PaymentReference,
  AllowedMerchants,
  LineItems,
  LineItemRequirements,
  Merchant,
  Amount,
  PaymentInstrument,
  PISP,
  Item,
  Checkout,
  LineItem,
  Total,
  Buyer,
  Link,
} from "./generated.ts";

/** Verifiable Credential Type (vct) constants, per the canonical schemas. */
export const VCT = {
  openPaymentMandate: "mandate.payment.open.1",
  paymentMandate: "mandate.payment.1",
  openCheckoutMandate: "mandate.checkout.open.1",
  checkoutMandate: "mandate.checkout.1",
} as const;
export type Vct = (typeof VCT)[keyof typeof VCT];

/** A payment constraint (discriminated on `type`). */
export type PaymentConstraint =
  | import("./generated.ts").AgentRecurrence
  | import("./generated.ts").AllowedPayees
  | import("./generated.ts").AllowedPaymentInstruments
  | import("./generated.ts").AllowedPisps
  | import("./generated.ts").AmountRange
  | import("./generated.ts").Budget
  | import("./generated.ts").ExecutionDate
  | import("./generated.ts").PaymentReference;

/** A checkout constraint (discriminated on `type`). */
export type CheckoutConstraint =
  | import("./generated.ts").AllowedMerchants
  | import("./generated.ts").LineItems;
