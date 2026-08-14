import { FunctionTool } from '@google/adk';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { A2AClient } from '@a2a-js/sdk/client';
import type {
  DataPart,
  MessageSendParams,
  SendMessageSuccessResponse,
  Task,
} from '@a2a-js/sdk';
import type { CartMandate } from '../../common/types/cart-mandate.js';
import type { PaymentMandate } from '../../common/types/payment-mandate.js';
import { DATA_KEYS } from '../../common/constants/index.js';
import { issueL1ForUser } from '../../common/vi/issue.js';
import { createUserAuthorization } from '../../common/vi/user-authorization.js';
import { AGENT_URLS } from '../index.js';

/** Wrap a promise with a timeout to prevent hanging on unresponsive agents. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

const A2A_TIMEOUT_MS = 30_000;

/**
 * Tool 1: Update Cart
 *
 * Updates the cart with shipping address and gets signed CartMandate from merchant.
 */
export const updateCart = new FunctionTool({
  name: 'updateCart',
  description: 'Updates the cart with the shipping address. Call this after receiving the shipping address from the shipping_address_collector subagent.',
  parameters: z.object({
    _trigger: z.boolean().optional().describe('Tool trigger'),
  }),
  execute: async (input, context) => {
    if (!context) throw new Error('Missing execution context');
    const cartMandate = context.state.get('cartMandate') as CartMandate | undefined;
    const shippingAddress = context.state.get('shippingAddress');
    const shoppingContextId = context.state.get('shoppingContextId') as string | undefined;
    const riskData = context.state.get('riskData') as string | undefined;

    if (!cartMandate) {
      throw new Error('No cart mandate found. Ensure the shopper subagent has provided a cart.');
    }

    if (!shippingAddress) {
      throw new Error('No shipping address found. Ensure the shipping address collector has provided an address.');
    }

    const client = await A2AClient.fromCardUrl(AGENT_URLS.MERCHANT);

    const sendParams: MessageSendParams = {
      message: {
        messageId: uuidv4(),
        role: 'user',
        contextId: shoppingContextId,
        parts: [
          { kind: 'text', text: 'Update the cart with the shipping address.' },
          { kind: 'data', data: { cart_id: cartMandate.contents.id } },
          { kind: 'data', data: { shipping_address: shippingAddress } },
          { kind: 'data', data: { shopping_agent_id: 'trusted_shopping_agent' } },
        ],
        kind: 'message',
      },
    };

    if (riskData) {
      sendParams.message.parts.push({ kind: 'data', data: { risk_data: riskData } });
    }

    const response = await withTimeout(client.sendMessage(sendParams), A2A_TIMEOUT_MS, 'updateCart');

    if ('error' in response) {
      throw new Error(response.error.message);
    }

    const result = (response as SendMessageSuccessResponse).result;
    if (result.kind === 'task') {
      const task = result as Task;
      if (task.status.state !== 'completed') {
        throw new Error(`Failed to update cart: ${task.status.state}`);
      }

      // Extract updated cart mandate
      for (const artifact of task.artifacts ?? []) {
        for (const part of artifact.parts) {
          if (part.kind === 'data') {
            const data = (part as DataPart).data as Record<string, unknown>;
            if (data[DATA_KEYS.CART_MANDATE]) {
              context.state.set('cartMandate', data[DATA_KEYS.CART_MANDATE]);
              return { status: 'success', message: 'Cart updated with shipping address' };
            }
          }
        }
      }

      throw new Error('No updated cart mandate received from merchant');
    }

    throw new Error('Unexpected response type from merchant');
  },
});

/**
 * Tool 2: Create Payment Mandate
 *
 * Creates a PaymentMandate from the cart and payment method.
 */
export const createPaymentMandate = new FunctionTool({
  name: 'createPaymentMandate',
  description: 'Creates a payment mandate from the cart mandate and payment credential token.',
  parameters: z.object({
    _trigger: z.boolean().optional().describe('Tool trigger'),
  }),
  execute: async (input, context) => {
    if (!context) throw new Error('Missing execution context');
    const cartMandate = context.state.get('cartMandate') as CartMandate | undefined;
    const paymentCredentialToken = context.state.get('paymentCredentialToken') as string | undefined;

    if (!cartMandate) {
      throw new Error('No cart mandate found');
    }

    if (!paymentCredentialToken) {
      throw new Error('No payment credential token found');
    }

    const shippingAddress = context.state.get('shippingAddress') as Record<string, unknown> | undefined;
    const userEmail = context.state.get('userEmail') as string | undefined;
    const paymentRequest = cartMandate.contents.paymentRequest;

    const paymentMandate: PaymentMandate = {
      paymentMandateContents: {
        paymentMandateId: uuidv4(),
        paymentDetailsId: paymentRequest.details.id,
        paymentDetailsTotal: paymentRequest.details.total,
        paymentResponse: {
          requestId: paymentRequest.details.id,
          methodName: paymentRequest.methodData[0].supportedMethods,
          details: { token: paymentCredentialToken },
          shippingAddress: shippingAddress || undefined,
          payerEmail: userEmail || undefined,
        },
        merchantAgent: cartMandate.contents.merchantName,
        timestamp: new Date().toISOString(),
      },
    };

    context.state.set('paymentMandate', paymentMandate);

    return { status: 'success', paymentMandate };
  },
});

/**
 * Tool 3: Sign Mandates on User Device
 *
 * Signs the payment mandate with a Verifiable Intent (VI) delegation chain:
 * an L1 issuer credential plus an L2 immediate user mandate over the final
 * cart and payment values, carried in `userAuthorization` and verified by
 * the payment processor.
 */
export const signMandatesOnUserDevice = new FunctionTool({
  name: 'signMandatesOnUserDevice',
  description: 'Signs the payment mandate on the user\'s trusted device with a Verifiable Intent credential chain.',
  parameters: z.object({
    _trigger: z.boolean().optional().describe('Tool trigger'),
  }),
  execute: async (input, context) => {
    if (!context) throw new Error('Missing execution context');
    const paymentMandate = context.state.get('paymentMandate') as PaymentMandate | undefined;
    const cartMandate = context.state.get('cartMandate') as CartMandate | undefined;

    if (!paymentMandate) {
      throw new Error('No payment mandate found to sign');
    }

    if (!cartMandate) {
      throw new Error('No cart mandate found to sign');
    }

    // In production the L1 issuer credential is minted by the credentials
    // provider and fetched over A2A; for the demo it is issued locally with
    // the issuer dev key.
    const l1 = await issueL1ForUser();
    const userAuthorization = await createUserAuthorization({
      l1,
      cartMandate,
      paymentMandateContents: paymentMandate.paymentMandateContents,
    });
    const signedPaymentMandate: PaymentMandate = {
      ...paymentMandate,
      userAuthorization,
    };

    context.state.set('signedPaymentMandate', signedPaymentMandate);

    return { status: 'success', message: 'Payment mandate signed on user device' };
  },
});

/**
 * Tool 4: Send Signed Payment Mandate to Credentials Provider
 *
 * Sends the signed payment mandate to the credentials provider for validation.
 */
export const sendSignedPaymentMandateToCredentialsProvider = new FunctionTool({
  name: 'sendSignedPaymentMandateToCredentialsProvider',
  description: 'Sends the signed payment mandate to the credentials provider.',
  parameters: z.object({
    _trigger: z.boolean().optional().describe('Tool trigger'),
  }),
  execute: async (input, context) => {
    if (!context) throw new Error('Missing execution context');
    const signedPaymentMandate = context.state.get('signedPaymentMandate') as PaymentMandate | undefined;
    const shoppingContextId = context.state.get('shoppingContextId') as string | undefined;
    const riskData = context.state.get('riskData') as string | undefined;

    if (!signedPaymentMandate) {
      throw new Error('No signed payment mandate found');
    }

    const client = await A2AClient.fromCardUrl(AGENT_URLS.CREDENTIALS_PROVIDER);

    const sendParams: MessageSendParams = {
      message: {
        messageId: uuidv4(),
        role: 'user',
        contextId: shoppingContextId,
        parts: [
          { kind: 'text', text: 'Store this signed payment mandate.' },
          { kind: 'data', data: { [DATA_KEYS.PAYMENT_MANDATE]: signedPaymentMandate } },
        ],
        kind: 'message',
      },
    };

    if (riskData) {
      sendParams.message.parts.push({ kind: 'data', data: { risk_data: riskData } });
    }

    const response = await withTimeout(client.sendMessage(sendParams), A2A_TIMEOUT_MS, 'sendSignedPaymentMandate');

    if ('error' in response) {
      throw new Error(response.error.message);
    }

    const result = (response as SendMessageSuccessResponse).result;
    if (result.kind === 'task') {
      const task = result as Task;
      if (task.status.state !== 'completed') {
        throw new Error(`Failed to send signed mandate: ${task.status.state}`);
      }

      return { status: 'success', message: 'Signed payment mandate sent to credentials provider' };
    }

    throw new Error('Unexpected response type from credentials provider');
  },
});

/**
 * Tool 5: Initiate Payment
 *
 * Initiates payment by sending the payment mandate to the merchant.
 */
export const initiatePayment = new FunctionTool({
  name: 'initiatePayment',
  description: 'Initiates the payment by sending the payment mandate to the merchant.',
  parameters: z.object({
    _trigger: z.boolean().optional().describe('Tool trigger'),
  }),
  execute: async (input, context) => {
    if (!context) throw new Error('Missing execution context');
    const signedPaymentMandate = context.state.get('signedPaymentMandate') as PaymentMandate | undefined;
    const shoppingContextId = context.state.get('shoppingContextId') as string | undefined;
    const riskData = context.state.get('riskData') as string | undefined;

    if (!signedPaymentMandate) {
      throw new Error('No signed payment mandate found');
    }

    const client = await A2AClient.fromCardUrl(AGENT_URLS.MERCHANT);

    const sendParams: MessageSendParams = {
      message: {
        messageId: uuidv4(),
        role: 'user',
        contextId: shoppingContextId,
        parts: [
          { kind: 'text', text: 'Initiate payment for this signed mandate.' },
          { kind: 'data', data: { [DATA_KEYS.PAYMENT_MANDATE]: signedPaymentMandate } },
          { kind: 'data', data: { shopping_agent_id: 'trusted_shopping_agent' } },
        ],
        kind: 'message',
      },
    };

    if (riskData) {
      sendParams.message.parts.push({ kind: 'data', data: { risk_data: riskData } });
    }

    const initiatePaymentTaskId = context.state.get('initiatePaymentTaskId') as string | undefined;
    if (initiatePaymentTaskId) {
      sendParams.message.taskId = initiatePaymentTaskId;
    }

    const stream = client.sendMessageStream(sendParams);
    let finalTask: Task | null = initiatePaymentTaskId
      ? {
          kind: 'task' as const,
          id: initiatePaymentTaskId,
          contextId: '',
          status: { state: 'working' as const, timestamp: new Date().toISOString() },
          artifacts: [],
        }
      : null;
    let challengeData: unknown = null;

    for await (const event of stream) {
      if (event.kind === 'task') {
        finalTask = event;
      } else if (event.kind === 'artifact-update') {
        if (finalTask) {
          if (!finalTask.artifacts) finalTask.artifacts = [];
          finalTask.artifacts.push(event.artifact);
        }
      } else if (event.kind === 'status-update') {
        if (finalTask) {
          finalTask.status = event.status;
          if (event.taskId) finalTask.id = event.taskId;
          if (event.contextId) finalTask.contextId = event.contextId;
        }
        if (event.status.state === 'input-required') {
          const message = event.status.message;
          if (message?.parts) {
            for (const part of message.parts) {
              if (part.kind === 'data') {
                const data = (part as DataPart).data as Record<string, unknown>;
                if (data.challenge) {
                  challengeData = data.challenge;
                }
              }
            }
          }
        }
      }
    }

    if (!finalTask) {
      throw new Error('No final task received from merchant');
    }

    // F7: retain initiatePaymentTaskId only across the input-required OTP
    // round-trip; clear it on every terminal outcome so a later purchase in the
    // same session does not attach a stale (terminal) task id.
    if (finalTask.status.state === 'input-required' && challengeData) {
      context.state.set('initiatePaymentTaskId', finalTask.id);
      return {
        status: 'input-required',
        challenge: challengeData,
        message: 'OTP challenge required',
      };
    }

    context.state.set('initiatePaymentTaskId', undefined);

    if (finalTask.status.state === 'completed') {
      // Extract payment receipt using canonical key
      for (const artifact of finalTask.artifacts ?? []) {
        for (const part of artifact.parts) {
          if (part.kind === 'data') {
            const data = (part as DataPart).data as Record<string, unknown>;
            if (data[DATA_KEYS.PAYMENT_RECEIPT]) {
              context.state.set('paymentReceipt', data[DATA_KEYS.PAYMENT_RECEIPT]);
              return { status: 'success', receipt: data[DATA_KEYS.PAYMENT_RECEIPT] };
            }
          }
        }
      }
      return { status: 'success', message: 'Payment completed' };
    }

    throw new Error(`Payment failed: ${finalTask.status.state}`);
  },
});

/**
 * Tool 6: Initiate Payment with OTP
 *
 * Retries payment with OTP challenge response.
 */
export const initiatePaymentWithOtp = new FunctionTool({
  name: 'initiatePaymentWithOtp',
  description: 'Retries the payment with the OTP challenge response.',
  parameters: z.object({
    challengeResponse: z.string().describe('The OTP or challenge response from the user'),
  }),
  execute: async (input, context) => {
    if (!context) throw new Error('Missing execution context');
    const { challengeResponse } = input;
    const signedPaymentMandate = context.state.get('signedPaymentMandate') as PaymentMandate | undefined;
    const shoppingContextId = context.state.get('shoppingContextId') as string | undefined;
    const riskData = context.state.get('riskData') as string | undefined;
    const initiatePaymentTaskId = context.state.get('initiatePaymentTaskId') as string | undefined;

    if (!signedPaymentMandate) {
      throw new Error('No signed payment mandate found');
    }

    if (!initiatePaymentTaskId) {
      throw new Error('No existing payment task found');
    }

    const client = await A2AClient.fromCardUrl(AGENT_URLS.MERCHANT);

    const sendParams: MessageSendParams = {
      message: {
        messageId: uuidv4(),
        role: 'user',
        taskId: initiatePaymentTaskId,
        contextId: shoppingContextId,
        parts: [
          { kind: 'text', text: 'Retry payment with OTP response.' },
          { kind: 'data', data: { [DATA_KEYS.PAYMENT_MANDATE]: signedPaymentMandate } },
          { kind: 'data', data: { challenge_response: challengeResponse } },
          { kind: 'data', data: { shopping_agent_id: 'trusted_shopping_agent' } },
        ],
        kind: 'message',
      },
    };

    if (riskData) {
      sendParams.message.parts.push({ kind: 'data', data: { risk_data: riskData } });
    }

    const stream = client.sendMessageStream(sendParams);
    let finalTask: Task | null = {
      kind: 'task' as const,
      id: initiatePaymentTaskId,
      contextId: shoppingContextId || '',
      status: { state: 'working' as const, timestamp: new Date().toISOString() },
      artifacts: [],
    };

    for await (const event of stream) {
      if (event.kind === 'task') {
        finalTask = event;
      } else if (event.kind === 'artifact-update') {
        if (finalTask) {
          if (!finalTask.artifacts) finalTask.artifacts = [];
          finalTask.artifacts.push(event.artifact);
        }
      } else if (event.kind === 'status-update') {
        if (finalTask) {
          finalTask.status = event.status;
          if (event.taskId) finalTask.id = event.taskId;
          if (event.contextId) finalTask.contextId = event.contextId;
        }
      }
    }

    if (!finalTask) {
      throw new Error('No final task received from merchant');
    }

    // F7: the OTP retry has reached a terminal outcome — clear the task id so a
    // later purchase in this session starts a fresh payment-processor task.
    context.state.set('initiatePaymentTaskId', undefined);

    if (finalTask.status.state === 'completed') {
      // Extract payment receipt using canonical key
      for (const artifact of finalTask.artifacts ?? []) {
        for (const part of artifact.parts) {
          if (part.kind === 'data') {
            const data = (part as DataPart).data as Record<string, unknown>;
            if (data[DATA_KEYS.PAYMENT_RECEIPT]) {
              context.state.set('paymentReceipt', data[DATA_KEYS.PAYMENT_RECEIPT]);
              return { status: 'success', receipt: data[DATA_KEYS.PAYMENT_RECEIPT] };
            }
          }
        }
      }
      return { status: 'success', message: 'Payment completed' };
    }

    throw new Error(`Payment failed: ${finalTask.status.state}`);
  },
});
