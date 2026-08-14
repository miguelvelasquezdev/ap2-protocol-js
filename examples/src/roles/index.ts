/** Agent card URLs for server agents in the AP2 system. */
export const AGENT_URLS = {
  CREDENTIALS_PROVIDER: 'http://localhost:8002/.well-known/agent-card.json',
  PAYMENT_PROCESSOR: 'http://localhost:8003/.well-known/agent-card.json',
  MERCHANT: 'http://localhost:8004/.well-known/agent-card.json',
} as const;
