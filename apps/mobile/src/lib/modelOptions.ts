import type {
  ClientSettings,
  ModelSelection,
  ProviderDriverKind,
  ProviderOptionDescriptor,
  ServerConfig as T3ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";

export type ModelOption = {
  readonly key: string;
  readonly label: string;
  readonly subtitle: string;
  readonly providerKey: string;
  readonly providerDriver: ProviderDriverKind;
  readonly providerLabel: string;
  readonly selection: ModelSelection;
};

export type ProviderGroup = {
  readonly providerKey: string;
  readonly providerLabel: string;
  readonly models: ReadonlyArray<ModelOption>;
  readonly isFavorites?: boolean;
};

export type ModelMenuAction = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly image?: string;
  readonly state?: "on";
  readonly displayInline?: boolean;
  readonly subactions?: ModelMenuAction[];
};

const EMPTY_MODEL_CAPABILITIES = { optionDescriptors: [] };

function providerDisplayLabel(provider: ServerProvider): string {
  return provider.displayName ?? PROVIDER_DISPLAY_NAMES[provider.driver] ?? provider.instanceId;
}

export function getModelSelectionProviderKey(
  selection: ModelSelection | null | undefined,
): string | null {
  return selection?.instanceId ?? null;
}

export function getModelSelectionDriver(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): ProviderDriverKind | null {
  return findServerProvider(config, getModelSelectionProviderKey(selection))?.driver ?? null;
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
      const key = `${provider.instanceId}:${model.slug}`;
      const preservedOptions =
        fallbackModelSelection?.instanceId === provider.instanceId
          ? fallbackModelSelection.options
          : undefined;
      options.set(key, {
        key,
        label: model.name,
        subtitle: providerLabel,
        providerKey: provider.instanceId,
        providerDriver: provider.driver,
        providerLabel,
        selection: {
          instanceId: provider.instanceId,
          model: model.slug,
          ...(preservedOptions ? { options: preservedOptions } : {}),
        },
      });
    }
  }

  if (fallbackModelSelection) {
    const key = `${fallbackModelSelection.instanceId}:${fallbackModelSelection.model}`;
    if (!options.has(key)) {
      options.set(key, {
        key,
        label: fallbackModelSelection.model,
        subtitle: fallbackModelSelection.instanceId,
        providerKey: fallbackModelSelection.instanceId,
        providerDriver: fallbackModelSelection.instanceId as unknown as ProviderDriverKind,
        providerLabel: fallbackModelSelection.instanceId,
        selection: fallbackModelSelection,
      });
    }
  }

  return [...options.values()];
}

export function groupByProvider(options: ReadonlyArray<ModelOption>): ReadonlyArray<ProviderGroup> {
  const groups = new Map<string, { providerLabel: string; models: ModelOption[] }>();
  for (const option of options) {
    const existing = groups.get(option.providerKey);
    if (existing) {
      existing.models.push(option);
    } else {
      groups.set(option.providerKey, {
        providerLabel: option.providerLabel,
        models: [option],
      });
    }
  }

  return [...groups.entries()].map(([providerKey, group]) => ({
    providerKey,
    providerLabel: group.providerLabel,
    models: group.models,
  }));
}

export function buildFavoriteModelGroup(
  options: ReadonlyArray<ModelOption>,
  favorites: ClientSettings["favorites"],
): ProviderGroup | null {
  if (favorites.length === 0) {
    return null;
  }

  const favoriteModels = favorites
    .map((favorite) =>
      options.find(
        (option) =>
          option.providerKey === favorite.provider && option.selection.model === favorite.model,
      ),
    )
    .filter((option): option is ModelOption => option !== undefined);

  if (favoriteModels.length === 0) {
    return null;
  }

  return {
    providerKey: "favorites",
    providerLabel: "Favorites",
    models: favoriteModels,
    isFavorites: true,
  };
}

export function groupModelOptionsForMenu(
  options: ReadonlyArray<ModelOption>,
  favorites: ClientSettings["favorites"],
): ReadonlyArray<ProviderGroup> {
  const favoriteGroup = buildFavoriteModelGroup(options, favorites);
  const providerGroups = groupByProvider(options);
  return favoriteGroup ? [favoriteGroup, ...providerGroups] : providerGroups;
}

function isSelectedModel(
  option: ModelOption,
  selection: ModelSelection | null | undefined,
): boolean {
  return (
    !!selection &&
    option.selection.instanceId === selection.instanceId &&
    option.selection.model === selection.model
  );
}

function providerGroupToMenuAction(
  group: ProviderGroup,
  selectedModel: ModelSelection | null | undefined,
): ModelMenuAction {
  return {
    id: `provider:${group.providerKey}`,
    title: group.providerLabel,
    ...(group.isFavorites ? { image: "star.fill" } : {}),
    subtitle: group.models.find((model) => isSelectedModel(model, selectedModel))?.label,
    subactions: group.models.map((option) => ({
      id: `model:${option.key}`,
      title: option.label,
      ...(group.isFavorites ? { subtitle: option.providerLabel } : {}),
      state: isSelectedModel(option, selectedModel) ? "on" : undefined,
    })),
  };
}

export function buildModelMenuActions(
  groups: ReadonlyArray<ProviderGroup>,
  selectedModel: ModelSelection | null | undefined,
): ModelMenuAction[] {
  const actions = groups.map((group) => providerGroupToMenuAction(group, selectedModel));
  const [firstAction, ...remainingActions] = actions;
  const hasFavorites = groups[0]?.isFavorites === true && firstAction !== undefined;
  if (!hasFavorites) {
    return actions;
  }

  return [
    {
      id: "model-section:favorites",
      title: "",
      displayInline: true,
      subactions: [firstAction],
    },
    {
      id: "model-section:providers",
      title: "",
      displayInline: true,
      subactions: remainingActions,
    },
  ];
}

export function findServerProvider(
  config: T3ServerConfig | null | undefined,
  provider: string | null | undefined,
): ServerProvider | null {
  return config?.providers.find((entry) => entry.instanceId === provider) ?? null;
}

export function getModelOptionDescriptors(
  config: T3ServerConfig | null | undefined,
  selection: ModelSelection | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!selection) {
    return [];
  }

  const provider = findServerProvider(config, selection.instanceId);
  const model = provider?.models.find((entry) => entry.slug === selection.model);
  return getProviderOptionDescriptors({
    caps: model?.capabilities ?? EMPTY_MODEL_CAPABILITIES,
    selections: selection.options,
  });
}

export function setModelSelectionOptionValue(
  selection: ModelSelection,
  id: string,
  value: string | boolean | undefined,
): ModelSelection {
  const existing = selection.options ?? [];
  const nextOptions =
    value === undefined
      ? existing.filter((option) => option.id !== id)
      : [
          ...existing.filter((option) => option.id !== id),
          {
            id,
            value,
          },
        ];
  return {
    ...selection,
    options: nextOptions,
  };
}

export function formatProviderOptionValue(
  descriptor: ProviderOptionDescriptor,
): string | undefined {
  if (descriptor.type === "boolean") {
    const value = getProviderOptionCurrentValue(descriptor);
    return value === true ? "On" : "Off";
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  if (typeof currentValue !== "string") {
    return undefined;
  }
  return descriptor.options.find((option) => option.id === currentValue)?.label ?? currentValue;
}
