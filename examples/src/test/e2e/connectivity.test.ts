import { describe, it, expect } from 'vitest';
import { A2AClient } from '@a2a-js/sdk/client';
import { v4 as uuidv4 } from 'uuid';

const SHOPPING_AGENT_URL = 'http://localhost:8001/.well-known/agent-card.json';

describe('Shopping Agent connectivity', () => {
  it('serves an agent card', async () => {
    const response = await fetch(SHOPPING_AGENT_URL);
    expect(response.ok).toBe(true);
    const card = await response.json();
    expect(card.name).toBeTruthy();
  });

  it('responds to a basic message via A2A', async () => {
    const client = await A2AClient.fromCardUrl(SHOPPING_AGENT_URL);

    const stream = client.sendMessageStream({
      message: {
        kind: 'message',
        messageId: uuidv4(),
        role: 'user',
        contextId: uuidv4(),
        parts: [{ kind: 'text', text: 'Hello, are you working?' }],
      },
    });

    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
      if (events.length >= 5) break;
    }
    expect(events.length).toBeGreaterThan(0);
  }, 15_000);
});
