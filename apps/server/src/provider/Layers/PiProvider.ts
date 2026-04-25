import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type { ModelCapabilities, PiSettings, ServerProviderModel } from "@t3tools/contracts";
import { Cause, Effect, Layer, Result, Stream } from "effect";

import { createModelCapabilities } from "@t3tools/shared/model";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import { ServerSettingsService } from "../../serverSettings.ts";
import { PiProvider } from "../Services/PiProvider.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
} from "../providerSnapshot.ts";
import { runProcess } from "../../processRunner.ts";

const PROVIDER = "pi" as const;
const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "new",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const PI_THINKING_LEVEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "thinkingLevel",
      label: "Thinking",
      type: "select",
      currentValue: "medium",
      options: [
        { id: "off", label: "Off" },
        { id: "minimal", label: "Minimal" },
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "X High" },
      ],
    },
  ],
});

const BUILT_IN_PI_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "default",
    name: "Pi default",
    shortName: "Default",
    isCustom: false,
    capabilities: DEFAULT_PI_MODEL_CAPABILITIES,
  },
];

type PiDiscoveredModel = Readonly<{
  provider?: unknown;
  id?: unknown;
  modelId?: unknown;
  name?: unknown;
  reasoning?: unknown;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProbeError(cause: unknown): { installed: boolean; message: string } {
  const message = Cause.isCause(cause)
    ? Cause.pretty(cause)
    : cause instanceof Error
      ? cause.message
      : String(cause);
  const lower = message.toLowerCase();
  if (lower.includes("enoent") || lower.includes("notfound") || lower.includes("not found")) {
    return {
      installed: false,
      message: "Pi CLI (`pi`) is not installed or not on PATH.",
    };
  }
  return {
    installed: true,
    message: `Failed to execute Pi CLI health check: ${message}`,
  };
}

function piModelCapabilities(model: PiDiscoveredModel): ModelCapabilities {
  return model.reasoning === true ? PI_THINKING_LEVEL_CAPABILITIES : DEFAULT_PI_MODEL_CAPABILITIES;
}

function slugFromPiModel(model: PiDiscoveredModel): string | undefined {
  const provider = typeof model.provider === "string" ? model.provider.trim() : "";
  const id =
    typeof model.modelId === "string"
      ? model.modelId.trim()
      : typeof model.id === "string"
        ? model.id.trim()
        : "";
  if (!id) return undefined;
  if (id.includes("/")) return id;
  return provider ? `${provider}/${id}` : id;
}

function serverProviderModelFromPiModel(model: PiDiscoveredModel): ServerProviderModel | undefined {
  const slug = slugFromPiModel(model);
  if (!slug) return undefined;
  const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : slug;
  return {
    slug,
    name,
    shortName: name,
    isCustom: false,
    capabilities: piModelCapabilities(model),
  };
}

function mergePiModels(input: {
  readonly discoveredModels: ReadonlyArray<ServerProviderModel>;
  readonly settings: PiSettings;
}): ReadonlyArray<ServerProviderModel> {
  const builtIns = input.discoveredModels.length > 0 ? input.discoveredModels : BUILT_IN_PI_MODELS;
  return providerModelsFromSettings(
    builtIns,
    PROVIDER,
    input.settings.customModels,
    DEFAULT_PI_MODEL_CAPABILITIES,
  );
}

function discoverPiModels(binaryPath: string): Promise<ReadonlyArray<ServerProviderModel>> {
  return new Promise((resolve) => {
    const id = randomUUID();
    const child = spawn(binaryPath, ["--mode", "rpc", "--no-session"], {
      stdio: "pipe",
      env: process.env,
    });
    let stdout = "";
    let settled = false;
    const timeout = setTimeout(() => finish([]), 4_000);

    const finish = (models: ReadonlyArray<ServerProviderModel>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill("SIGTERM");
      resolve(models);
    };

    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) break;
        const line = stdout.slice(0, newline).replace(/\r$/, "");
        stdout = stdout.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const payload = JSON.parse(line) as unknown;
          if (!isRecord(payload) || payload.type !== "response" || payload.id !== id) {
            continue;
          }
          const data = isRecord(payload.data) ? payload.data : {};
          const models = Array.isArray(data.models)
            ? data.models
                .filter(isRecord)
                .map(serverProviderModelFromPiModel)
                .filter((model): model is ServerProviderModel => model !== undefined)
            : [];
          finish(models);
        } catch {
          // Keep reading; stderr/non-JSON startup noise should not break discovery.
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id, type: "get_available_models" })}\n`);
  });
}

const probePi = (settings: PiSettings) =>
  Effect.tryPromise(() =>
    runProcess(settings.binaryPath, ["--version"], {
      allowNonZeroExit: true,
      timeoutMs: 4_000,
      outputMode: "truncate",
    }),
  ).pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) {
        return {
          ...normalizeProbeError(result.failure),
          version: null,
          status: "error" as const,
          auth: { status: "unknown" as const },
        };
      }
      const value = result.success;
      const output = `${value.stdout}\n${value.stderr}`.trim();
      return {
        installed: true,
        version: parseGenericCliVersion(output),
        status: value.code === 0 ? ("ready" as const) : ("error" as const),
        auth: { status: "unknown" as const },
        ...(value.code === 0 ? {} : { message: output || `Pi exited with code ${value.code}.` }),
      };
    }),
  );

export const PiProviderLive = Layer.effect(
  PiProvider,
  Effect.gen(function* () {
    const settingsService = yield* ServerSettingsService;

    const buildSnapshot = Effect.fn("PiProvider.buildSnapshot")(function* () {
      const settingsResult = yield* settingsService.getSettings.pipe(Effect.result);
      const settings = Result.isFailure(settingsResult)
        ? DEFAULT_SERVER_SETTINGS.providers.pi
        : settingsResult.success.providers.pi;
      const probe = yield* probePi(settings);
      const discoveredModels =
        probe.installed && settings.enabled
          ? yield* Effect.tryPromise(() => discoverPiModels(settings.binaryPath)).pipe(
              Effect.result,
              Effect.map((result) => (Result.isSuccess(result) ? result.success : [])),
            )
          : [];
      return buildServerProvider({
        provider: PROVIDER,
        presentation: PI_PRESENTATION,
        enabled: settings.enabled,
        checkedAt: new Date().toISOString(),
        models: mergePiModels({ discoveredModels, settings }),
        probe,
      });
    });

    return {
      getSnapshot: buildSnapshot(),
      refresh: buildSnapshot(),
      streamChanges: Stream.empty,
    };
  }),
);
