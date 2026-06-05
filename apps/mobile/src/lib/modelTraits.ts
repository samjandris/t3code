import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";

import type { ModelOption } from "./modelOptions";

export type MobileMenuAction = {
  readonly id: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly state?: "on" | "off" | "mixed" | undefined;
  readonly attributes?: { readonly disabled?: boolean } | undefined;
  readonly subactions?: MobileMenuAction[] | undefined;
};

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

export function getModelTraitDescriptors(input: {
  readonly option: ModelOption | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.option?.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.option.capabilities,
    selections: input.selections,
  });
}

export function buildModelTraitMenuActions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): MobileMenuAction[] {
  return descriptors.map((descriptor) => {
    if (descriptor.type === "boolean") {
      const currentValue = getProviderOptionCurrentValue(descriptor) === true;
      return {
        id: `options:trait:${descriptor.id}`,
        title: descriptor.label,
        subtitle: currentValue ? "On" : "Off",
        subactions: [
          {
            id: `options:trait:${descriptor.id}:boolean:on`,
            title: "On",
            state: currentValue ? ("on" as const) : undefined,
          },
          {
            id: `options:trait:${descriptor.id}:boolean:off`,
            title: "Off",
            state: !currentValue ? ("on" as const) : undefined,
          },
        ],
      };
    }

    const currentValue = getProviderOptionCurrentValue(descriptor);
    const subtitle = getProviderOptionCurrentLabel(descriptor);
    return {
      id: `options:trait:${descriptor.id}`,
      title: descriptor.label,
      ...(subtitle ? { subtitle } : {}),
      subactions: descriptor.options.map((option) => ({
        id: `options:trait:${descriptor.id}:select:${option.id}`,
        title: `${option.label}${option.isDefault ? " (default)" : ""}`,
        state: currentValue === option.id ? ("on" as const) : undefined,
      })),
    };
  });
}

export function updateModelSelectionTrait(input: {
  readonly selection: ModelSelection;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly event: string;
}): ModelSelection | null {
  const prefix = "options:trait:";
  if (!input.event.startsWith(prefix)) {
    return null;
  }
  const rest = input.event.slice(prefix.length);
  const selectMarker = ":select:";
  const booleanMarker = ":boolean:";
  const selectIndex = rest.indexOf(selectMarker);
  const booleanIndex = rest.indexOf(booleanMarker);
  const descriptorId =
    selectIndex >= 0
      ? rest.slice(0, selectIndex)
      : booleanIndex >= 0
        ? rest.slice(0, booleanIndex)
        : null;
  if (!descriptorId) {
    return null;
  }

  const descriptor = input.descriptors.find((candidate) => candidate.id === descriptorId);
  if (!descriptor) {
    return null;
  }

  const value =
    descriptor.type === "boolean"
      ? rest.slice(booleanIndex + booleanMarker.length) === "on"
      : rest.slice(selectIndex + selectMarker.length);
  const nextDescriptors = replaceDescriptorCurrentValue(input.descriptors, descriptor.id, value);
  const nextOptions = buildProviderOptionSelectionsFromDescriptors(nextDescriptors);
  return nextOptions ? { ...input.selection, options: nextOptions } : input.selection;
}
