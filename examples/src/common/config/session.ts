import 'dotenv/config';
import { InMemorySessionService } from '@google/adk';

/**
 * Global session service for ADK agents.
 *
 * Each agent server process gets its own instance (since ES modules are
 * per-process). In ADK dev mode (`npm run dev`), all agents share this
 * single instance within the same process, which is the intended behavior
 * for local development.
 */
export const sessionService = new InMemorySessionService();
