import type { intentMandateSchema } from "../schemas/intent-mandate.js";
import type { z } from "zod";

export type IntentMandate = z.infer<typeof intentMandateSchema>;
