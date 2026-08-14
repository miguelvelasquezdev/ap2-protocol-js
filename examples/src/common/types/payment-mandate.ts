import type { paymentMandateSchema } from "../schemas/payment-mandate.js";
import type { z } from "zod";

export type PaymentMandate = z.infer<typeof paymentMandateSchema>;
