/**
 * GENERATED FILE - do not edit by hand.
 * Source of truth: code/sdk/schemas (canonical AP2 JSON Schemas).
 * Regenerate: node scripts/generate-schemas.mjs
 */
import { z } from "zod";

/** agent_recurrence: Provides conditions for the agent to reuse this Payment Mandate multiple times. */
export const AgentRecurrenceSchema = z.looseObject({
  type: z.literal("payment.agent_recurrence"),
  frequency: z.enum(["ON_DEMAND", "DAILY", "WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "ANNUALLY"]),
  max_occurrences: z.number().int().optional(),
});
export type AgentRecurrence = z.infer<typeof AgentRecurrenceSchema>;

/** Merchant: Schema defining a Mechant object */
export const MerchantSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  website: z.string().optional(),
});
export type Merchant = z.infer<typeof MerchantSchema>;

/** allowed_payees: Defines the set of possible payees. */
export const AllowedPayeesSchema = z.looseObject({
  type: z.literal("payment.allowed_payees"),
  allowed: z.array(MerchantSchema),
});
export type AllowedPayees = z.infer<typeof AllowedPayeesSchema>;

/** Payment Instrument: Instrument used for payment. */
export const PaymentInstrumentSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  description: z.string().optional(),
});
export type PaymentInstrument = z.infer<typeof PaymentInstrumentSchema>;

/** allowed_payment_instruments: Defines the set of possible payment instruments for this Payment Mandate. */
export const AllowedPaymentInstrumentsSchema = z.looseObject({
  type: z.literal("payment.allowed_payment_instruments"),
  allowed: z.array(PaymentInstrumentSchema),
});
export type AllowedPaymentInstruments = z.infer<typeof AllowedPaymentInstrumentsSchema>;

/** PISP: Schema defining a Payment Initiation Service Provider (PISP) object */
export const PISPSchema = z.looseObject({
  legal_name: z.string(),
  brand_name: z.string(),
  domain_name: z.string(),
});
export type PISP = z.infer<typeof PISPSchema>;

/** allowed_pisps: Defines the set of Payment Initiation Service Providers (PISPs) authorized to facilitate the transaction. */
export const AllowedPispsSchema = z.looseObject({
  type: z.literal("payment.allowed_pisps"),
  allowed: z.array(PISPSchema),
});
export type AllowedPisps = z.infer<typeof AllowedPispsSchema>;

/** amount_range: Defines the valid range for the payment amount */
export const AmountRangeSchema = z.looseObject({
  type: z.literal("payment.amount_range"),
  currency: z.string(),
  max: z.number().int(),
  min: z.number().int().optional(),
});
export type AmountRange = z.infer<typeof AmountRangeSchema>;

/** budget: Defines the maximum total amount that can be spent when using the payment.agent_recurrence constraint. */
export const BudgetSchema = z.looseObject({
  type: z.literal("payment.budget"),
  max: z.number(),
  currency: z.string(),
});
export type Budget = z.infer<typeof BudgetSchema>;

/** execution_date: Defines the valid time window for the payment execution. */
export const ExecutionDateSchema = z.looseObject({
  type: z.literal("payment.execution_date"),
  not_before: z.string().optional(),
  not_after: z.string().optional(),
});
export type ExecutionDate = z.infer<typeof ExecutionDateSchema>;

/** payment_reference: Constrains the payment to a specific checkout reference. */
export const PaymentReferenceSchema = z.looseObject({
  type: z.literal("payment.reference"),
  conditional_transaction_id: z.string(),
});
export type PaymentReference = z.infer<typeof PaymentReferenceSchema>;

/** Amount: Schema defining an Amount and Current object */
export const AmountSchema = z.looseObject({
  amount: z.number().int(),
  currency: z.string(),
});
export type Amount = z.infer<typeof AmountSchema>;

/** Open Payment Mandate: Agreement between a user and an agent (or chain of agents) to authorize future payment actions. */
export const OpenPaymentMandateSchema = z.looseObject({
  vct: z.literal("mandate.payment.open.1"),
  constraints: z.array(z.discriminatedUnion("type", [AgentRecurrenceSchema, AllowedPayeesSchema, AllowedPaymentInstrumentsSchema, AllowedPispsSchema, AmountRangeSchema, BudgetSchema, ExecutionDateSchema, PaymentReferenceSchema])).refine((arr) => arr.some((c) => c.type === "payment.reference"), { message: "must contain at least one payment.reference constraint" }),
  cnf: z.record(z.string(), z.unknown()),
  payee: MerchantSchema.optional(),
  payment_amount: AmountSchema.optional(),
  payment_instrument: PaymentInstrumentSchema.optional(),
  pisp: PISPSchema.optional(),
  execution_date: z.string().optional(),
  risk_data: z.record(z.string(), z.unknown()).optional(),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});
export type OpenPaymentMandate = z.infer<typeof OpenPaymentMandateSchema>;

/** Payment Mandate: Agreement from a User or an Agent to authorize a particular Payment action. */
export const PaymentMandateSchema = z.looseObject({
  vct: z.literal("mandate.payment.1"),
  transaction_id: z.string(),
  payee: MerchantSchema,
  pisp: PISPSchema.optional(),
  payment_amount: AmountSchema,
  payment_instrument: PaymentInstrumentSchema,
  execution_date: z.string().optional(),
  risk_data: z.record(z.string(), z.unknown()).optional(),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});
export type PaymentMandate = z.infer<typeof PaymentMandateSchema>;

/** allowed_merchants: Defines the set of possible merchants for this Checkout Mandate. */
export const AllowedMerchantsSchema = z.looseObject({
  type: z.literal("checkout.allowed_merchants"),
  allowed: z.array(MerchantSchema),
});
export type AllowedMerchants = z.infer<typeof AllowedMerchantsSchema>;

/** item: Defines an item that may be present in the Checkout Mandate. */
export const ItemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
});
export type Item = z.infer<typeof ItemSchema>;

/** line_item_requirements: Defines a line item that must be present in the Checkout Mandate. */
export const LineItemRequirementsSchema = z.looseObject({
  id: z.string(),
  acceptable_items: z.array(ItemSchema),
  quantity: z.number().int(),
});
export type LineItemRequirements = z.infer<typeof LineItemRequirementsSchema>;

/** line_items: Defines the sets of line items that are to be present in the Checkout Mandate. */
export const LineItemsSchema = z.looseObject({
  type: z.literal("checkout.line_items"),
  items: z.array(LineItemRequirementsSchema),
});
export type LineItems = z.infer<typeof LineItemsSchema>;

/** Open Checkout Mandate: Agreement between a user and an agent (or chain of agents) to authorize future checkout actions. */
export const OpenCheckoutMandateSchema = z.looseObject({
  vct: z.literal("mandate.checkout.open.1"),
  constraints: z.array(z.discriminatedUnion("type", [AllowedMerchantsSchema, LineItemsSchema])).refine((arr) => arr.some((c) => c.type === "checkout.line_items"), { message: "must contain at least one checkout.line_items constraint" }),
  cnf: z.record(z.string(), z.unknown()),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});
export type OpenCheckoutMandate = z.infer<typeof OpenCheckoutMandateSchema>;

/** Checkout Mandate: Agreement from a User or an Agent to authorize a particular Checkout action. */
export const CheckoutMandateSchema = z.looseObject({
  vct: z.literal("mandate.checkout.1"),
  checkout_jwt: z.string(),
  checkout_hash: z.string(),
  iat: z.number().int().optional(),
  exp: z.number().int().optional(),
});
export type CheckoutMandate = z.infer<typeof CheckoutMandateSchema>;

/** Payment Receipt Success */
export const PaymentReceiptSuccessSchema = z.looseObject({
  status: z.literal("Success"),
  iss: z.string(),
  iat: z.number().int(),
  reference: z.string(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  payment_id: z.string(),
  psp_confirmation_id: z.string(),
  network_confirmation_id: z.string(),
});
export type PaymentReceiptSuccess = z.infer<typeof PaymentReceiptSuccessSchema>;

/** Payment Receipt Error */
export const PaymentReceiptErrorSchema = z.looseObject({
  status: z.literal("Error"),
  iss: z.string(),
  iat: z.number().int(),
  reference: z.string(),
  error: z.string(),
  error_description: z.string(),
  payment_id: z.string(),
  psp_confirmation_id: z.string().optional(),
  network_confirmation_id: z.string().optional(),
});
export type PaymentReceiptError = z.infer<typeof PaymentReceiptErrorSchema>;

/** Payment Receipt: Receipt that supplies information about the final state of a payment. */
export const PaymentReceiptSchema = z.discriminatedUnion("status", [PaymentReceiptSuccessSchema, PaymentReceiptErrorSchema]);
export type PaymentReceipt = z.infer<typeof PaymentReceiptSchema>;

/** Checkout Receipt Success */
export const CheckoutReceiptSuccessSchema = z.looseObject({
  status: z.literal("Success"),
  iss: z.string(),
  iat: z.number().int(),
  reference: z.string(),
  error: z.string().optional(),
  error_description: z.string().optional(),
  order_id: z.string(),
});
export type CheckoutReceiptSuccess = z.infer<typeof CheckoutReceiptSuccessSchema>;

/** Checkout Receipt Error */
export const CheckoutReceiptErrorSchema = z.looseObject({
  status: z.literal("Error"),
  iss: z.string(),
  iat: z.number().int(),
  reference: z.string(),
  error: z.string(),
  error_description: z.string(),
  order_id: z.string().optional(),
});
export type CheckoutReceiptError = z.infer<typeof CheckoutReceiptErrorSchema>;

/** Checkout Receipt: Receipt that supplies information about the final state of a checkout. */
export const CheckoutReceiptSchema = z.discriminatedUnion("status", [CheckoutReceiptSuccessSchema, CheckoutReceiptErrorSchema]);
export type CheckoutReceipt = z.infer<typeof CheckoutReceiptSchema>;

/** Item: Product details for a line item. Matches UCP types/item.json (2026-04-08). */
export const Ap2ItemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  price: z.number().int(),
  image_url: z.string().optional(),
});
export type Ap2Item = z.infer<typeof Ap2ItemSchema>;

/** Total: A cost breakdown entry with a category, amount, and optional display text. */
export const TotalSchema = z.looseObject({
  type: z.string(),
  display_text: z.string().optional(),
  amount: z.number().int(),
});
export type Total = z.infer<typeof TotalSchema>;

/** LineItem: UCP line item (dev.ucp.shopping 2026-04-08). Uses nested item object for product details. */
export const LineItemSchema = z.looseObject({
  id: z.string(),
  item: Ap2ItemSchema,
  quantity: z.number().int(),
  totals: z.array(TotalSchema),
  parent_id: z.string().optional(),
});
export type LineItem = z.infer<typeof LineItemSchema>;

/** Link: A typed URL reference for legal compliance or informational links. */
export const LinkSchema = z.looseObject({
  type: z.string(),
  url: z.string(),
  title: z.string().optional(),
});
export type Link = z.infer<typeof LinkSchema>;

/** Buyer: Representation of the buyer. Matches UCP types/buyer.json (2026-04-08). */
export const BuyerSchema = z.looseObject({
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email: z.string().optional(),
  phone_number: z.string().optional(),
});
export type Buyer = z.infer<typeof BuyerSchema>;

/** MessageError: Error message. Matches UCP types/message_error.json (2026-04-08). */
export const MessageErrorSchema = z.looseObject({
  type: z.literal("error"),
  code: z.string(),
  path: z.string().optional(),
  content_type: z.enum(["plain", "markdown"]).optional(),
  content: z.string(),
  severity: z.enum(["recoverable", "requires_buyer_input", "requires_buyer_review", "unrecoverable"]),
});
export type MessageError = z.infer<typeof MessageErrorSchema>;

/** MessageWarning: Warning message. Matches UCP types/message_warning.json (2026-04-08). */
export const MessageWarningSchema = z.looseObject({
  type: z.literal("warning"),
  path: z.string().optional(),
  code: z.string(),
  content: z.string(),
  content_type: z.enum(["plain", "markdown"]).optional(),
  presentation: z.string().optional(),
  image_url: z.string().optional(),
  url: z.string().optional(),
});
export type MessageWarning = z.infer<typeof MessageWarningSchema>;

/** MessageInfo: Informational message. Matches UCP types/message_info.json (2026-04-08). */
export const MessageInfoSchema = z.looseObject({
  type: z.literal("info"),
  path: z.string().optional(),
  code: z.string().optional(),
  content_type: z.enum(["plain", "markdown"]).optional(),
  content: z.string(),
});
export type MessageInfo = z.infer<typeof MessageInfoSchema>;

/** Message: Container for error, warning, or info messages. Matches UCP types/message.json (2026-04-08). */
export const MessageSchema = z.union([MessageErrorSchema, MessageWarningSchema, MessageInfoSchema]);
export type Message = z.infer<typeof MessageSchema>;

/** Checkout: UCP Checkout object (dev.ucp.shopping.checkout 2026-04-08). The merchant field is an AP2 extension for mandate binding. */
export const CheckoutSchema = z.looseObject({
  id: z.string(),
  merchant: MerchantSchema.optional(),
  line_items: z.array(LineItemSchema),
  status: z.enum(["incomplete", "requires_escalation", "ready_for_complete", "complete_in_progress", "completed", "canceled"]),
  currency: z.string(),
  totals: z.array(TotalSchema),
  links: z.array(LinkSchema),
  buyer: BuyerSchema.optional(),
  messages: z.array(MessageSchema).optional(),
  expires_at: z.string().optional(),
  continue_url: z.string().optional(),
});
export type Checkout = z.infer<typeof CheckoutSchema>;
