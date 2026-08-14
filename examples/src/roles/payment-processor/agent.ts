import { LlmAgent } from "@google/adk";
import { DEBUG_MODE_INSTRUCTIONS } from "../../common/constants/index.js";
import { initiatePayment } from "./tools.js";

/**
 * Payment Processor Agent (ADK)
 *
 * Processes card payments on behalf of merchants with OTP challenge support.
 */
export const paymentProcessorAgent = new LlmAgent({
  name: "payment_processor_agent",
  model: "gemini-2.5-flash",
  description: "An agent that processes card payments on behalf of a merchant.",
  instruction: `You are a payment processor agent that handles card payments.

When you receive a payment mandate, call the initiatePayment tool to process it.
The tool will handle the OTP challenge flow automatically.

Call the initiatePayment tool exactly once per request. After the tool returns
a result, respond with a brief summary of the outcome. Do not call the tool
again after it has already returned.

${DEBUG_MODE_INSTRUCTIONS}`,
  tools: [initiatePayment],
});
