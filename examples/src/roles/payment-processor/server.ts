import { Runner } from '@google/adk';
import type { AgentCard } from '@a2a-js/sdk';

import { paymentProcessorAgent } from './agent.js';
import { sessionService } from '../../common/config/session.js';
import { BaseAgentExecutor } from '../../common/server/base-executor.js';
import { bootstrapServer } from '../../common/server/bootstrap.js';

const runner = new Runner({
  appName: 'ap2-payment-processor',
  agent: paymentProcessorAgent,
  sessionService,
});

const agentExecutor = new BaseAgentExecutor({
  agentName: 'payment_processor_agent',
  appName: 'ap2-payment-processor',
  runner,
  maxLlmCalls: 3,
  workingMessage: 'Processing payment...',
  postprocessResult({ lastToolResult, responseText: _responseText, toolWasCalled: _toolWasCalled }) {
    // If tool returned input-required or completed, it already published
    // the status update directly via eventBus -- suppress default handling
    if (lastToolResult?.status === 'input-required' || lastToolResult?.status === 'completed') {
      return null; // Signal: already handled
    }

    // Otherwise, let the base class handle default completion
    return undefined;
  },
});

const agentCard: AgentCard = {
  name: 'MerchantPaymentProcessorAgent',
  description: 'An agent that processes card payments on behalf of a merchant.',
  url: 'http://localhost:8003',
  provider: { organization: 'AP2 Demo', url: 'https://github.com/google-agentic-commerce/ap2' },
  skills: [
    {
      id: 'card-processor',
      name: 'Card Processor',
      description: 'Processes card payments.',
      tags: ['payment', 'card'],
    },
  ],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
    extensions: [
      {
        uri: 'https://github.com/google-agentic-commerce/ap2/v1',
        description: 'Supports the Agent Payments Protocol.',
        required: true,
      },
      {
        uri: 'https://sample-card-network.github.io/paymentmethod/common/types/v1',
        description:
          'Supports the Sample Card Network payment method extension',
        required: true,
      },
    ],
  },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/json'],
  protocolVersion: '0.3.0',
  version: '1.0.0',
};

bootstrapServer({
  agentCard,
  agentExecutor,
  port: 8003,
  label: 'PaymentProcessor',
});
