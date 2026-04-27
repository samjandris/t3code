import { describe, expect, it } from "vitest";

import {
  mergePiDiscoveredModels,
  parsePiModelsResponse,
  piModelsFromSettings,
} from "./PiProvider.ts";

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

  it("does not include the auto fallback when discovered models are available", () => {
    const models = mergePiDiscoveredModels(
      {
        enabled: true,
        binaryPath: "pi",
        configDir: "",
        customModels: [],
      },
      parsePiModelsResponse({
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet",
            name: "Claude Sonnet",
          },
        ],
      }),
    );

    expect(models.map((model) => model.slug)).toEqual(["anthropic/claude-sonnet"]);
  });

  it("does not expose Pi's internal auto fallback when discovery is unavailable", () => {
    const models = piModelsFromSettings({
      enabled: true,
      binaryPath: "pi",
      configDir: "",
      customModels: [],
    });

    expect(models.map((model) => model.slug)).toEqual([]);
  });

  it("keeps custom models when discovery is unavailable", () => {
    const models = piModelsFromSettings({
      enabled: true,
      binaryPath: "pi",
      configDir: "",
      customModels: ["openrouter/custom-model"],
    });

    expect(models.map((model) => model.slug)).toEqual(["openrouter/custom-model"]);
  });

  it("appends custom models after discovered models", () => {
    const models = mergePiDiscoveredModels(
      {
        enabled: true,
        binaryPath: "pi",
        configDir: "",
        customModels: ["openrouter/custom-model"],
      },
      [
        {
          slug: "anthropic/claude-sonnet",
          name: "Claude Sonnet",
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        },
      ],
    );

    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet",
      "openrouter/custom-model",
    ]);
  });
});
