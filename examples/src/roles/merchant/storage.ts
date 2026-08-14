/**
 * In-memory storage for CartMandates and risk data.
 *
 * A CartMandate may be updated multiple times during the course of a shopping
 * journey. This storage system is used to persist CartMandates between
 * interactions between the shopper and merchant agents.
 */

import type { CartMandate } from "../../common/types/cart-mandate.js";

// Separate stores for type safety — avoids union-type ambiguity
const cartMandateStore = new Map<string, CartMandate>();
const riskDataStore = new Map<string, string>();

/**
 * Get a cart mandate by cart ID.
 */
export function getCartMandate(cartId: string): CartMandate | undefined {
  return cartMandateStore.get(cartId);
}

/**
 * Set a cart mandate by cart ID.
 */
export function setCartMandate(cartId: string, cartMandate: CartMandate): void {
  cartMandateStore.set(cartId, cartMandate);
}

/**
 * Set risk data by context ID.
 */
export function setRiskData(contextId: string, riskData: string): void {
  riskDataStore.set(contextId, riskData);
}

/**
 * Get risk data by context ID.
 */
export function getRiskData(contextId: string): string | undefined {
  return riskDataStore.get(contextId);
}
