/**
 * Offline unit tests for the Verifiable Intent layer (no network, no LLM).
 * Run with: npx vitest run src/test/vi
 */
import { describe, expect, it } from 'vitest';
import type { CartMandate } from '../../common/types/cart-mandate.js';
import type { PaymentMandate } from '../../common/types/payment-mandate.js';
import { issueL1ForUser } from '../../common/vi/issue.js';
import { createUserAuthorization } from '../../common/vi/user-authorization.js';
import { verifyUserAuthorization } from '../../common/vi/verify.js';

const AMOUNT = { currency: 'USD', value: 29.99 };

function makeCartMandate(): CartMandate {
  return {
    contents: {
      id: 'cart-001',
      userCartConfirmationRequired: false,
      paymentRequest: {
        methodData: [{ supportedMethods: 'CARD', data: {} }],
        details: {
          id: 'payment-request-001',
          displayItems: [{ label: 'Running shoes', amount: AMOUNT, refundPeriod: 30 }],
          total: { label: 'Total', amount: AMOUNT, refundPeriod: 30 },
        },
        options: {},
      },
      cartExpiry: new Date(Date.now() + 3600_000).toISOString(),
      merchantName: 'Demo Merchant',
    },
  };
}

function makePaymentMandateContents(): PaymentMandate['paymentMandateContents'] {
  return {
    paymentMandateId: 'payment-mandate-001',
    paymentDetailsId: 'payment-request-001',
    paymentDetailsTotal: { label: 'Total', amount: AMOUNT, refundPeriod: 30 },
    paymentResponse: {
      requestId: 'payment-request-001',
      methodName: 'CARD',
      details: { token: 'demo-token' },
    },
    merchantAgent: 'Demo Merchant',
    timestamp: new Date().toISOString(),
  };
}

/** Flip one character in the middle of a serialized SD-JWT's payload segment. */
function tamperPayload(serialized: string): string {
  const tildeIdx = serialized.indexOf('~');
  const jwt = tildeIdx === -1 ? serialized : serialized.slice(0, tildeIdx);
  const rest = tildeIdx === -1 ? '' : serialized.slice(tildeIdx);
  const [h, p, s] = jwt.split('.');
  const i = Math.floor(p!.length / 2);
  const flipped = p![i] === 'A' ? 'B' : 'A';
  return `${h}.${p!.slice(0, i)}${flipped}${p!.slice(i + 1)}.${s}${rest}`;
}

describe('Verifiable Intent userAuthorization', () => {
  it('round trip: issue → verify is valid', async () => {
    const contents = makePaymentMandateContents();
    const l1 = await issueL1ForUser();
    const userAuthorization = await createUserAuthorization({
      l1,
      cartMandate: makeCartMandate(),
      paymentMandateContents: contents,
    });

    const result = await verifyUserAuthorization(userAuthorization, contents);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects a tampered L2 segment', async () => {
    const contents = makePaymentMandateContents();
    const l1 = await issueL1ForUser();
    const bundle = JSON.parse(
      await createUserAuthorization({
        l1,
        cartMandate: makeCartMandate(),
        paymentMandateContents: contents,
      })
    ) as { l1: string; l2: string };
    bundle.l2 = tamperPayload(bundle.l2);

    const result = await verifyUserAuthorization(JSON.stringify(bundle), contents);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects when the mandate amount does not match the disclosed L2 amount', async () => {
    const contents = makePaymentMandateContents();
    const l1 = await issueL1ForUser();
    const userAuthorization = await createUserAuthorization({
      l1,
      cartMandate: makeCartMandate(),
      paymentMandateContents: contents,
    });

    const tamperedContents = {
      ...contents,
      paymentDetailsTotal: {
        ...contents.paymentDetailsTotal,
        amount: { currency: 'USD', value: 99.99 },
      },
    };
    const result = await verifyUserAuthorization(userAuthorization, tamperedContents);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('does not match'))).toBe(true);
  });

  it('rejects when verified against the wrong expected audience', async () => {
    const contents = makePaymentMandateContents();
    const l1 = await issueL1ForUser();
    const userAuthorization = await createUserAuthorization({
      l1,
      cartMandate: makeCartMandate(),
      paymentMandateContents: contents,
    });

    const result = await verifyUserAuthorization(
      userAuthorization,
      contents,
      'https://evil.example'
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
