import { describe, expect, it } from "vitest";

import type { ServerConfig } from "@t3tools/contracts";
import { buildModelMenuActions, buildModelOptions, groupModelOptionsForMenu } from "./modelOptions";

const BASE_PROVIDER = {
  enabled: true,
  installed: true,
  version: null,
  status: "ready" as const,
  auth: { status: "authenticated" as const },
  checkedAt: "2026-04-29T00:00:00.000Z",
  slashCommands: [],
  skills: [],
};

const CONFIG = {
  providers: [
    {
      ...BASE_PROVIDER,
      provider: "cursor" as const,
      models: [{ slug: "composer-2", name: "Composer 2", isCustom: false, capabilities: null }],
    },
    {
      ...BASE_PROVIDER,
      provider: "opencode" as const,
      models: [
        {
          slug: "github-copilot/claude-sonnet-4-6",
          name: "Claude Sonnet 4.6",
          isCustom: false,
          capabilities: null,
        },
      ],
    },
    {
      ...BASE_PROVIDER,
      provider: "codex" as const,
      models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
    },
  ],
} as unknown as ServerConfig;

describe("mobile model options", () => {
  it("uses shared provider display names", () => {
    const providerLabels = groupModelOptionsForMenu(buildModelOptions(CONFIG, null), []).map(
      (group) => group.providerLabel,
    );

    expect(providerLabels).toEqual(["Cursor", "OpenCode", "Codex"]);
  });

  it("adds favorites as the first menu section with provider subtitles", () => {
    const options = buildModelOptions(CONFIG, null);
    const groups = groupModelOptionsForMenu(options, [
      { provider: "opencode", model: "github-copilot/claude-sonnet-4-6" },
      { provider: "cursor", model: "composer-2" },
    ]);
    const actions = buildModelMenuActions(groups, null);

    expect(groups[0]).toMatchObject({
      providerKey: "favorites",
      providerLabel: "Favorites",
      isFavorites: true,
    });
    expect(actions[0]).toMatchObject({
      id: "model-section:favorites",
      displayInline: true,
      subactions: [
        {
          id: "provider:favorites",
          title: "Favorites",
          image: "star.fill",
        },
      ],
    });
    expect(actions[0]?.subactions?.[0]?.subactions).toEqual([
      {
        id: "model:opencode:github-copilot/claude-sonnet-4-6",
        title: "Claude Sonnet 4.6",
        subtitle: "OpenCode",
        state: undefined,
      },
      {
        id: "model:cursor:composer-2",
        title: "Composer 2",
        subtitle: "Cursor",
        state: undefined,
      },
    ]);
    expect(actions[1]).toMatchObject({
      id: "model-section:providers",
      displayInline: true,
    });
  });
});
