import type { paymentReceiptSchema } from "../schemas/payment-receipt.js";
import type { z } from "zod";

export type PaymentReceipt = z.infer<typeof paymentReceiptSchema>;
