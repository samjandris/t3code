import { describe, expect, it } from "vitest";

import { parsePiModelsResponse } from "./PiProvider.ts";

describe("PiProvider", () => {
  it("maps Pi RPC model records to provider models", () => {
    expect(
      parsePiModelsResponse({
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet",
            name: "Claude Sonnet",
            reasoning: true,
          },
          {
            id: "ollama/llama3",
            name: "Llama 3",
          },
        ],
      }),
    ).toMatchObject([
      {
        slug: "anthropic/claude-sonnet",
        name: "Claude Sonnet",
        isCustom: false,
        capabilities: {
          optionDescriptors: [{ id: "reasoningEffort" }],
        },
      },
      {
        slug: "ollama/llama3",
        name: "Llama 3",
        isCustom: false,
      },
    ]);
  });
});
