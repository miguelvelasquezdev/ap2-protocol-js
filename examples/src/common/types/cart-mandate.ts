import type { cartMandateSchema } from "../schemas/cart-mandate.js";
import type { z } from "zod";

export type CartMandate = z.infer<typeof cartMandateSchema>;
