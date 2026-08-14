import { v4 as uuidv4 } from 'uuid';
import { Runner } from '@google/adk';
import type {
  AgentCard,
  Message,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';

import { shoppingAgent } from './agent.js';
import { sessionService } from '../../common/config/session.js';
import { BaseAgentExecutor } from '../../common/server/base-executor.js';
import { bootstrapServer } from '../../common/server/bootstrap.js';

const runner = new Runner({
  appName: 'ap2-shopping-agent',
  agent: shoppingAgent,
  sessionService,
});

const agentExecutor = new BaseAgentExecutor({
  agentName: 'root_agent',
  appName: 'ap2-shopping-agent',
  runner,
  workingMessage: 'Processing your shopping request...',
  postprocessResult({
    responseText,
    toolWasCalled,
    session,
    eventBus,
    taskId,
    contextId,
  }) {
    // Check if payment receipt was generated (indicates completion)
    const paymentReceipt = session.state.paymentReceipt;
    const isTaskComplete = !!paymentReceipt;

    const fallbackText = (!responseText && !toolWasCalled && !isTaskComplete)
      ? 'I encountered an issue processing your request. Could you please try again?'
      : undefined;

    const finalResponseText = fallbackText || responseText || 'Processing...';

    // Publish artifact if payment receipt was generated
    if (isTaskComplete && paymentReceipt) {
      eventBus.publish({
        kind: 'artifact-update',
        taskId,
        contextId,
        artifact: {
          artifactId: uuidv4(),
          parts: [
            { kind: 'data', data: { paymentReceipt } },
          ],
        },
      } satisfies TaskArtifactUpdateEvent);
    }

    const agentMessage: Message = {
      kind: 'message',
      role: 'agent',
      messageId: uuidv4(),
      parts: [{ kind: 'text', text: finalResponseText }],
      taskId,
      contextId,
    };

    return {
      kind: 'status-update',
      taskId,
      contextId,
      status: {
        state: isTaskComplete ? 'completed' : 'input-required',
        message: agentMessage,
        timestamp: new Date().toISOString(),
      },
      final: true,
    } satisfies TaskStatusUpdateEvent;
  },
});

const agentCard: AgentCard = {
  name: 'ShoppingAgent',
  description: 'A shopping agent that helps users find and purchase products from merchants.',
  url: 'http://localhost:8001',
  provider: { organization: 'AP2 Demo', url: 'https://github.com/google-agentic-commerce/ap2' },
  skills: [
    {
      id: 'shop_for_products',
      name: 'Shop for Products',
      description: 'Help users find and purchase products from merchants.',
      tags: ['shopping', 'payments', 'e-commerce'],
    },
  ],
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: true,
  },
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['application/json'],
  protocolVersion: '0.3.0',
  version: '1.0.0',
};

bootstrapServer({
  agentCard,
  agentExecutor,
  port: 8001,
  label: 'ShoppingAgent',
});
