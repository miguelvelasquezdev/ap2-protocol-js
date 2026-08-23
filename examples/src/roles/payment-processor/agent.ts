import { LlmAgent } from "@google/adk";
import { DEBUG_MODE_INSTRUCTIONS } from "../../common/constants/index.js";
import { initiatePayment } from "./tools.js";
import { GEMINI_MODEL } from '../../common/config/model.js';

/**
 * Payment Processor Agent (ADK)
 *
 * Processes card payments on behalf of merchants with OTP challenge support.
 */
export const paymentProcessorAgent = new LlmAgent({
  name: "payment_processor_agent",
  model: GEMINI_MODEL,
  description: "An agent that processes card payments on behalf of a merchant.",
  instruction: `You are a payment processor agent that handles card payments.

## ABSOLUTE RULE — you are the verifier; never fake a result

You do NOT decide whether a payment is valid. The initiatePayment tool does: it
cryptographically verifies the AP2 payment mandate and fails closed. Therefore:

- You MUST call initiatePayment for every payment request. Never answer from the
  message contents alone.
- NEVER say "Completed", "Processing payment", "success", "approved" or anything
  implying an outcome unless the tool RETURNED that outcome. If you have not
  called the tool, you have no outcome to report.
- If the tool returns an error (e.g. the mandate failed verification), report
  that error verbatim. Never soften it into a success.

Claiming a payment succeeded without calling the tool would let a forged or
tampered mandate through — the exact attack this agent exists to stop.

When you receive a payment mandate, call the initiatePayment tool to process it.
The tool will handle the OTP challenge flow automatically.

Call the initiatePayment tool exactly once per request. After the tool returns
a result, respond with a brief summary of the outcome. Do not call the tool
again after it has already returned.

${DEBUG_MODE_INSTRUCTIONS}`,
  tools: [initiatePayment],
});
