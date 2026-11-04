import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type ProviderConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsJsonMode: boolean;
  contextTokens: number;
  temperature?: number;
};

export interface LlmClient {
  readonly model: string;
  complete(messages: ChatMessage[], opts?: { json?: boolean }): Promise<string>;
}

/**
 * Provider-agnostic chat client for any OpenAI-compatible endpoint.
 * JSON mode is requested through the provider's `response_format` only when the
 * provider is configured to support it; `json` on its own is a no-op.
 */
export function createLlmClient(cfg: ProviderConfig): LlmClient {
  const provider = createOpenAICompatible({ name: "custom", baseURL: cfg.baseUrl, apiKey: cfg.apiKey });
  return {
    model: cfg.model,
    async complete(messages, opts = {}) {
      const jsonMode = opts.json === true && cfg.supportsJsonMode;
      const { text } = await generateText({
        model: provider(cfg.model),
        messages,
        temperature: cfg.temperature,
        ...(jsonMode ? { providerOptions: { custom: { response_format: { type: "json_object" } } } } : {}),
      });
      return text;
    },
  };
}
