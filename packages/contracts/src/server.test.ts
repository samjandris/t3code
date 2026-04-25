import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_SERVER_SETTINGS, ServerSettings, ServerProvider } from "./index.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding legacy snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
  });

  it("decodes Pi provider settings defaults", () => {
    const parsed = Schema.decodeUnknownSync(ServerSettings)({});

    expect(parsed.providers.pi).toEqual({
      enabled: true,
      binaryPath: "pi",
      configDir: "",
      customModels: [],
    });
    expect(DEFAULT_SERVER_SETTINGS.providers.pi.binaryPath).toBe("pi");
  });
});
