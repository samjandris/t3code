import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

const PROVIDER_OPTION_EVENT_PREFIX = "provider-option:";

function providerOptionEvent(id: string, value: string | boolean): string {
  return `${PROVIDER_OPTION_EVENT_PREFIX}${encodeURIComponent(JSON.stringify({ id, value }))}`;
}

function parseProviderOptionEvent(event: string): ProviderOptionSelection | null {
  if (!event.startsWith(PROVIDER_OPTION_EVENT_PREFIX)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(
      decodeURIComponent(event.slice(PROVIDER_OPTION_EVENT_PREFIX.length)),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      "value" in parsed &&
      (typeof parsed.value === "string" || typeof parsed.value === "boolean")
    ) {
      return { id: parsed.id, value: parsed.value };
    }
  } catch {
    return null;
  }

  return null;
}

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    selections: input.selections,
  });
}

/**
 * Labels for the option values currently in effect (select values plus
 * enabled booleans), used to summarize the thread configuration in the
 * composer trigger pill.
 */
export function providerOptionValueLabels(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<string> {
  return descriptors.flatMap((descriptor) => {
    if (descriptor.type === "boolean") {
      return descriptor.currentValue ? [descriptor.label] : [];
    }
    const label = getProviderOptionCurrentLabel(descriptor);
    return label ? [label] : [];
  });
}

export function buildProviderOptionMenuActions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): ReadonlyArray<MenuAction> {
  return descriptors.map((descriptor) => {
    const currentValue =
      descriptor.type === "boolean"
        ? (descriptor.currentValue ?? false)
        : getProviderOptionCurrentValue(descriptor);
    const choices =
      descriptor.type === "select"
        ? descriptor.options.map((option) => ({
            id: providerOptionEvent(descriptor.id, option.id),
            title: `${option.label}${option.isDefault ? " (default)" : ""}`,
            state: currentValue === option.id ? ("on" as const) : undefined,
          }))
        : ([false, true] as const).map((value) => ({
            id: providerOptionEvent(descriptor.id, value),
            title: value ? "On" : "Off",
            state: currentValue === value ? ("on" as const) : undefined,
          }));

    return {
      id: `provider-option-menu:${descriptor.id}`,
      title: descriptor.label,
      subtitle:
        descriptor.type === "boolean"
          ? currentValue
            ? "On"
            : "Off"
          : getProviderOptionCurrentLabel(descriptor),
      subactions: choices,
    };
  });
}

export function providerOptionsConfigurationLabel(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string {
  const labels = providerOptionValueLabels(descriptors);
  return labels.length > 0 ? labels.join(" · ") : "Configuration";
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}

export function applyProviderOptionMenuEvent(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  event: string,
): ReadonlyArray<ProviderOptionSelection> | null {
  const selection = parseProviderOptionEvent(event);
  return selection ? applyProviderOptionSelection(descriptors, selection) : null;
}
