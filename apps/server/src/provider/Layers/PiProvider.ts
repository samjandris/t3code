import type {
  ModelCapabilities,
  PiSettings,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { Cause, Effect, Equal, Layer, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import { ServerSettingsService } from "../../serverSettings.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  detailFromResult,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
} from "../providerSnapshot.ts";
import { PiProvider } from "../Services/PiProvider.ts";
import { ServerConfig } from "../../config.ts";

const PROVIDER = "pi" as const;
const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "RPC",
  showInteractionModeToggle: true,
} as const;

export const PI_REASONING_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium", isDefault: true },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Extra High" },
] as const;

export const PI_REASONING_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      options: PI_REASONING_OPTIONS,
    }),
  ],
});

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "auto",
    name: "Pi default",
    isCustom: false,
    capabilities: PI_REASONING_CAPABILITIES,
  },
];

function modelsFromSettings(settings: PiSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    FALLBACK_MODELS,
    PROVIDER,
    settings.customModels,
    PI_REASONING_CAPABILITIES,
  );
}

function makePendingPiProvider(settings: PiSettings): ServerProvider {
  const checkedAt = new Date().toISOString();
  const models = modelsFromSettings(settings);
  if (!settings.enabled) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Pi is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Pi availability...",
    },
  });
}

function normalizePiModelSlug(model: unknown): string | undefined {
  if (!model || typeof model !== "object") return undefined;
  const record = model as Record<string, unknown>;
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const id =
    typeof record.id === "string"
      ? record.id.trim()
      : typeof record.model === "string"
        ? record.model.trim()
        : "";
  if (!id) return undefined;
  return provider && !id.includes("/") ? `${provider}/${id}` : id;
}

function normalizePiModelName(model: unknown, slug: string): string {
  if (!model || typeof model !== "object") return slug;
  const record = model as Record<string, unknown>;
  return (
    (typeof record.name === "string" && record.name.trim()) ||
    (typeof record.displayName === "string" && record.displayName.trim()) ||
    slug
  );
}

export function parsePiModelsResponse(value: unknown): ReadonlyArray<ServerProviderModel> {
  const records = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).models)
      ? ((value as Record<string, unknown>).models as ReadonlyArray<unknown>)
      : [];
  return records.flatMap((model) => {
    const slug = normalizePiModelSlug(model);
    if (!slug) return [];
    const reasoning =
      model && typeof model === "object" && (model as Record<string, unknown>).reasoning === true;
    return [
      {
        slug,
        name: normalizePiModelName(model, slug),
        isCustom: false,
        capabilities: reasoning ? PI_REASONING_CAPABILITIES : EMPTY_CAPABILITIES,
      },
    ] satisfies ReadonlyArray<ServerProviderModel>;
  });
}

const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (input: {
  readonly settings: PiSettings;
  readonly cwd: string;
}) {
  const checkedAt = new Date().toISOString();
  const fallbackModels = modelsFromSettings(input.settings);

  if (!input.settings.enabled) {
    return makePendingPiProvider(input.settings);
  }

  const versionExit = yield* Effect.exit(
    spawnAndCollect(
      input.settings.binaryPath,
      ChildProcess.make(input.settings.binaryPath, ["--version"], {
        cwd: input.cwd,
        shell: process.platform === "win32",
      }),
    ),
  );

  if (versionExit._tag === "Failure") {
    const cause = Cause.squash(versionExit.cause);
    const error = cause instanceof Error ? cause : new Error(String(cause));
    const message = isCommandMissingCause(error)
      ? "Pi CLI (`pi`) is not installed or not on PATH."
      : `Failed to execute Pi CLI health check: ${error.message}`;
    return buildServerProvider({
      provider: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message,
      },
    });
  }

  const versionResult = versionExit.value;
  const version = parseGenericCliVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
  if (versionResult.code !== 0) {
    return buildServerProvider({
      provider: PROVIDER,
      presentation: PI_PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "warning",
        auth: { status: "unknown" },
        message: detailFromResult(versionResult) ?? "Pi CLI health check failed.",
      },
    });
  }

  return buildServerProvider({
    provider: PROVIDER,
    presentation: PI_PRESENTATION,
    enabled: true,
    checkedAt,
    models: fallbackModels,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown", type: "pi" },
      message: "Pi CLI is available.",
    },
  });
});

export const PiProviderLive = Layer.effect(
  PiProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const getSettings = serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.pi),
      Effect.orDie,
    );

    return yield* makeManagedServerProvider<PiSettings>({
      getSettings,
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.pi),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: makePendingPiProvider,
      checkProvider: getSettings.pipe(
        Effect.flatMap((settings) =>
          checkPiProviderStatus({
            settings,
            cwd: serverConfig.cwd,
          }),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    });
  }),
);
