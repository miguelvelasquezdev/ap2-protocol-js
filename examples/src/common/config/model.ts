import "dotenv/config";

/**
 * The Gemini model every agent in this sample uses.
 *
 * Google retires models periodically (`gemini-2.5-flash` became unavailable to
 * new API keys, which made every agent fail with a generic "I encountered an
 * issue"). Keep it in ONE place and make it overridable, so a deprecation is a
 * one-line `.env` change instead of an edit in every role:
 *
 *   GEMINI_MODEL=gemini-3.6-flash
 */
export const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3.6-flash";
