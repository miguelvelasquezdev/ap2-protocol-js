 *   user request → cart → shipping → payment method → mandate → receipt.
 *
 * Assumes the four agents are already running locally (see scenario README).
 */

import { describe, it, expect } from 'vitest';
import { A2AClient } from '@a2a-js/sdk/client';
import type { Task } from '@a2a-js/sdk';
import { v4 as uuidv4 } from 'uuid';

const SHOPPING_AGENT_URL = 'http://localhost:8001/.well-known/agent-card.json';

describe('AP2 payment flow (e2e)', () => {
  it('initiates a shopping flow and reaches a working, completed, or input-required state', async () => {
    const client = await A2AClient.fromCardUrl(SHOPPING_AGENT_URL);

    const stream = client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: uuidv4(),
        role: 'user',
        contextId: uuidv4(),
        parts: [{ kind: 'text', text: 'I want to buy running shoes' }],
      },
    });

    let lastTask: Task | null = null;
    for await (const event of stream) {
      if (event.kind === 'task') lastTask = event;
    }

    expect(lastTask).not.toBeNull();
    expect(['working', 'completed', 'input-required']).toContain(
      lastTask!.status.state,
    );
  }, 60_000);
});
