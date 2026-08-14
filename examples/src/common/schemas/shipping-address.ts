import { z } from "zod";

export const shippingAddressSchema = z.object({
  city: z.string().optional(),
  country: z.string().optional(),
  dependent_locality: z.string().optional(),
  organization: z.string().optional(),
  phone_number: z.string().optional(),
  postal_code: z.string().optional(),
  recipient: z.string().optional(),
  region: z.string().optional(),
  sorting_code: z.string().optional(),
  address_line: z.array(z.string()).optional(),
});
