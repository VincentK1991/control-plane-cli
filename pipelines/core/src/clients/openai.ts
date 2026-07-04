import OpenAI from "openai";
import { config } from "../config.js";

let client: OpenAI | undefined;

/**
 * Shared across any pipeline that needs an LLM call (entity extraction,
 * entity-resolution judgment, future pipelines) so the API key handling and
 * client construction live in one place instead of being reimplemented per
 * workflow package.
 */
export function getOpenAIClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: config.openaiApiKey });
  }
  return client;
}
