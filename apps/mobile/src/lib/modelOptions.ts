import type {
  ModelCapabilities,
  ModelSelection,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly subProvider?: string;
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly providerDriver: string;
  readonly isFavorite?: boolean;
  readonly capabilities: ModelCapabilities | null;
  readonly selection: ModelSelection;
};

export type ModelFavorite = {
  readonly provider: string;
  readonly model: string;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerDriver: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
};

function providerDisplayLabel(provider: {
  readonly displayName?: string | undefined;
  readonly driver: string;
  readonly instanceId: string;
}): string {
  if (provider.displayName) return provider.displayName;
  if (provider.driver === "codex") return "Codex";
  if (provider.driver === "claudeAgent") return "Claude";
  return provider.instanceId;
}

export function modelOptionKey(selection: ModelSelection): string {
  return `${selection.instanceId}:${selection.model}`;
}

export function favoriteKey(favorite: ModelFavorite): string {
  return `${favorite.provider}:${favorite.model}`;
}

function favoriteRank(favorites: ReadonlyArray<ModelFavorite>): ReadonlyMap<string, number> {
  return new Map(favorites.map((favorite, index) => [favoriteKey(favorite), index] as const));
}

function normalizeSelectionOptions(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null,
): ModelSelection {
  if (!capabilities) {
    return selection;
  }
  const options = buildProviderOptionSelectionsFromDescriptors(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }),
  );
  return options
    ? { ...selection, options }
    : {
        instanceId: selection.instanceId,
        model: selection.model,
      };
}

export function buildModelOptions(
  config: T3ServerConfig | null | undefined,
  fallbackModelSelection: ModelSelection | null,
): ReadonlyArray<ModelOption> {
  const options = new Map<string, ModelOption>();

  for (const provider of config?.providers ?? []) {
    if (!provider.enabled || !provider.installed || provider.auth.status === "unauthenticated") {
      continue;
    }

    const providerLabel = providerDisplayLabel(provider);
    for (const model of provider.models) {
      const selection: ModelSelection = {
        instanceId: provider.instanceId,
        model: model.slug,
      };
      const key = modelOptionKey(selection);
      const subtitle =
        provider.driver === "opencode" && model.subProvider ? model.subProvider : providerLabel;
      options.set(key, {
        key,
        label: model.name,
        subtitle,
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        providerKey: provider.instanceId,
        providerLabel,
        providerDriver: provider.driver,
        capabilities: model.capabilities,
        selection: normalizeSelectionOptions(selection, model.capabilities),
      });
    }
  }

  if (fallbackModelSelection) {
    const key = modelOptionKey(fallbackModelSelection);
    const existing = options.get(key);
    if (existing) {
      options.set(key, {
        ...existing,
        selection: normalizeSelectionOptions(fallbackModelSelection, existing.capabilities),
      });
    } else {
      const providerLabel = fallbackModelSelection.instanceId;
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: providerLabel,
        providerKey: fallbackModelSelection.instanceId,
        providerLabel,
        providerDriver: fallbackModelSelection.instanceId,
        capabilities: null,
        selection: normalizeSelectionOptions(fallbackModelSelection, null),
      });
    }
  }

  return [...options.values()];
}

export function sortModelOptionsForMobile(
  options: ReadonlyArray<ModelOption>,
  favorites: ReadonlyArray<ModelFavorite>,
): ModelOption[] {
  const ranks = favoriteRank(favorites);
  const rankedOptions = options.map((option, index) => ({
    option: {
      ...option,
      isFavorite: ranks.has(option.key),
    },
    index,
    rank: ranks.get(option.key),
  }));

  rankedOptions.sort((left, right) => {
    const leftFavorite = left.rank !== undefined;
    const rightFavorite = right.rank !== undefined;
    if (leftFavorite !== rightFavorite) {
      return leftFavorite ? -1 : 1;
    }
    if (left.rank !== undefined && right.rank !== undefined && left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return left.index - right.index;
  });

  return rankedOptions.map((entry) => entry.option);
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<
    string,
    { providerDriver: string; providerLabel: string; models: ModelOption[] }
  >();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerDriver: option.providerDriver,
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerDriver: group.providerDriver,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

export function groupModelOptionsForMobile(
  options: ReadonlyArray<ModelOption>,
  favorites: ReadonlyArray<ModelFavorite>,
): ReadonlyArray<ProviderGroup> {
  return groupByProvider(sortModelOptionsForMobile(options, favorites));
}
