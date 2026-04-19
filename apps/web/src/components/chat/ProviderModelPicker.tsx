import { type ProviderKind, type ServerProvider } from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import {
  memo,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { VariantProps } from "class-variance-authority";
import { type ProviderPickerKind, PROVIDER_OPTIONS } from "../../session-logic";
import { ChevronDownIcon } from "lucide-react";
import { Button, buttonVariants } from "../ui/button";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ClaudeAI, CursorIcon, Gemini, Icon, OpenAI, OpenCodeIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { getProviderSnapshot } from "../../providerModels";

type ModelOption = { slug: string; name: string };
type ProviderModelOptionDisplayGroup = {
  label: string | null;
  items: ReadonlyArray<ModelOption & { label: string }>;
};

function isAvailableProviderOption(option: (typeof PROVIDER_OPTIONS)[number]): option is {
  value: ProviderKind;
  label: string;
  available: true;
} {
  return option.available;
}

const PROVIDER_ICON_BY_PROVIDER: Record<ProviderPickerKind, Icon> = {
  codex: OpenAI,
  claudeAgent: ClaudeAI,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
};

export const AVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter(isAvailableProviderOption);
const UNAVAILABLE_PROVIDER_OPTIONS = PROVIDER_OPTIONS.filter((option) => !option.available);
const COMING_SOON_PROVIDER_OPTIONS = [{ id: "gemini", label: "Gemini", icon: Gemini }] as const;
const MODEL_PANEL_POPUP_CLASS_NAME =
  "w-80 max-w-[min(20rem,calc(100vw-1rem))] overflow-hidden p-0 [--available-height:min(24rem,70vh)]";
const EMPTY_MODEL_SEARCH_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "",
  claudeAgent: "",
  cursor: "",
  opencode: "",
};

function providerIconClassName(
  provider: ProviderKind | ProviderPickerKind,
  fallbackClassName: string,
): string {
  if (provider === "claudeAgent") {
    return "text-[#d97757]";
  }
  if (provider === "opencode") {
    return "text-[#4f7cff]";
  }
  return fallbackClassName;
}

function titleCaseWords(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((segment) => {
      const upper = segment.toUpperCase();
      if (upper === "AI") return upper;
      if (/[0-9]/.test(segment) && upper.length <= 6) return upper;
      return segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase();
    })
    .join(" ");
}

function inferOpenCodeGroupLabel(option: ModelOption): string {
  const [providerLabel] = option.name.split("·").map((segment) => segment.trim());
  if (providerLabel && providerLabel !== option.name) {
    return providerLabel;
  }

  const slugProvider = option.slug.split("/")[0]?.trim();
  return slugProvider ? titleCaseWords(slugProvider.replaceAll(/[-_]+/g, " ")) : "Other";
}

function getOpenCodeGroupedItemLabel(
  option: Pick<ModelOption, "name">,
  groupLabel: string,
): string {
  const [providerLabel, trailingLabel] = option.name.split("·").map((segment) => segment.trim());
  if (trailingLabel && providerLabel === groupLabel) {
    return trailingLabel;
  }
  return option.name;
}

function groupProviderModelOptions(
  provider: ProviderKind,
  options: ReadonlyArray<ModelOption>,
): ReadonlyArray<ProviderModelOptionDisplayGroup> {
  if (provider !== "opencode") {
    return [{ label: null, items: options.map((option) => ({ ...option, label: option.name })) }];
  }

  const groups = new Map<string, Array<ModelOption & { label: string }>>();
  for (const option of options) {
    const label = inferOpenCodeGroupLabel(option);
    const group = groups.get(label) ?? [];
    group.push({
      ...option,
      label: getOpenCodeGroupedItemLabel(option, label),
    });
    groups.set(label, group);
  }
  return Array.from(groups.entries(), ([label, items]) => ({ label, items }));
}

function getSelectedProviderModelLabel(
  provider: ProviderKind,
  model: string,
  name?: string,
): string {
  const resolvedName = name ?? model;
  if (provider !== "opencode") {
    return resolvedName;
  }

  return getOpenCodeGroupedItemLabel(
    { name: resolvedName },
    inferOpenCodeGroupLabel({
      slug: model,
      name: resolvedName,
    }),
  );
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function filterModelOptions(
  options: ReadonlyArray<ModelOption>,
  query: string,
): ReadonlyArray<ModelOption> {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const normalizedName = option.name.toLowerCase();
    const normalizedSlug = option.slug.toLowerCase();
    return normalizedName.includes(normalizedQuery) || normalizedSlug.includes(normalizedQuery);
  });
}

function stopModelSearchInputKeyPropagation(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Escape") {
    event.stopPropagation();
  }
}

function getModelGroupLabelClassName(provider: ProviderKind): string | undefined {
  if (provider !== "opencode") {
    return undefined;
  }
  return "block -mx-1 sticky top-0 z-10 bg-popover px-3";
}

function getModelGroupKey(
  provider: ProviderKind,
  group: { label: string | null; items: ReadonlyArray<{ slug: string }> },
): string {
  if (group.label) {
    return `${provider}-group:${group.label}`;
  }
  const firstSlug = group.items[0]?.slug ?? "empty";
  const lastSlug = group.items[group.items.length - 1]?.slug ?? firstSlug;
  return `${provider}-group:${firstSlug}:${lastSlug}`;
}

function ModelPickerList(props: { provider: ProviderKind; children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [hasOverflow, setHasOverflow] = useState(false);
  const [showTopFade, setShowTopFade] = useState(false);
  const [showBottomFade, setShowBottomFade] = useState(false);

  const updateFadeVisibility = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const canScroll = viewport.scrollHeight > viewport.clientHeight + 1;
    setHasOverflow((current) => (current === canScroll ? current : canScroll));
    const nextShowTopFade = canScroll && viewport.scrollTop > 0;
    const nextShowBottomFade =
      canScroll && viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 1;
    setShowTopFade((current) => (current === nextShowTopFade ? current : nextShowTopFade));
    setShowBottomFade((current) => (current === nextShowBottomFade ? current : nextShowBottomFade));
  }, []);

  useLayoutEffect(() => {
    updateFadeVisibility();
    const viewport = viewportRef.current;
    if (!viewport || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => updateFadeVisibility());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [updateFadeVisibility, props.children]);

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={viewportRef}
        className="h-full min-h-0 overflow-y-auto"
        onScroll={updateFadeVisibility}
      >
        <div
          className={cn("not-empty:px-1 not-empty:pb-1", hasOverflow ? "pe-2.5" : undefined)}
          data-model-picker-list={props.provider}
        >
          {props.children}
        </div>
      </div>
      <div
        className={cn(
          "pointer-events-none absolute left-0 z-1 h-4 bg-linear-to-b from-popover/82 via-popover/52 to-transparent transition-opacity",
          hasOverflow ? "right-2.5" : "right-0",
          props.provider === "opencode" ? "top-7" : "top-0",
          showTopFade ? "opacity-100" : "opacity-0",
        )}
        data-model-picker-fade="top"
      />
      <div
        className={cn(
          "pointer-events-none absolute bottom-0 left-0 z-1 h-4 bg-linear-to-t from-popover/82 via-popover/52 to-transparent transition-opacity",
          hasOverflow ? "right-2.5" : "right-0",
          showBottomFade ? "opacity-100" : "opacity-0",
        )}
        data-model-picker-fade="bottom"
      />
    </div>
  );
}

export const ProviderModelPicker = memo(function ProviderModelPicker(props: {
  provider: ProviderKind;
  model: string;
  lockedProvider: ProviderKind | null;
  providers?: ReadonlyArray<ServerProvider>;
  modelOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  activeProviderIconClassName?: string;
  compact?: boolean;
  disabled?: boolean;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerClassName?: string;
  onProviderModelChange: (provider: ProviderKind, model: string) => void;
}) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [modelSearchByProvider, setModelSearchByProvider] = useState(
    EMPTY_MODEL_SEARCH_BY_PROVIDER,
  );
  const activeProvider = props.lockedProvider ?? props.provider;
  const selectedProviderOptions = props.modelOptionsByProvider[activeProvider];
  const selectedModelLabel = getSelectedProviderModelLabel(
    activeProvider,
    props.model,
    selectedProviderOptions.find((option) => option.slug === props.model)?.name,
  );
  const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[activeProvider];

  const clearModelSearchQueries = useCallback(() => {
    setModelSearchByProvider(EMPTY_MODEL_SEARCH_BY_PROVIDER);
  }, []);

  const setProviderSearchQuery = useCallback((provider: ProviderKind, query: string) => {
    setModelSearchByProvider((current) =>
      current[provider] === query ? current : { ...current, [provider]: query },
    );
  }, []);

  const handleModelChange = (provider: ProviderKind, value: string) => {
    if (props.disabled || !value) return;
    const resolvedModel = resolveSelectableModel(
      provider,
      value,
      props.modelOptionsByProvider[provider],
    );
    if (!resolvedModel) return;
    props.onProviderModelChange(provider, resolvedModel);
    clearModelSearchQueries();
    setIsMenuOpen(false);
  };

  const renderModelRadioItems = (
    provider: ProviderKind,
    items: ReadonlyArray<(ModelOption & { label: string }) | ModelOption>,
  ) =>
    items.map((modelOption) => (
      <MenuRadioItem
        key={`${provider}:${modelOption.slug}`}
        value={modelOption.slug}
        onClick={() => setIsMenuOpen(false)}
      >
        {"label" in modelOption ? modelOption.label : modelOption.name}
      </MenuRadioItem>
    ));

  const renderModelGroups = (provider: ProviderKind, options: ReadonlyArray<ModelOption>) => {
    const groups = groupProviderModelOptions(provider, options);
    return groups.map((group, groupIndex) => (
      <div
        key={getModelGroupKey(provider, group)}
        className={provider === "opencode" ? "px-1" : undefined}
      >
        {group.label ? (
          <MenuGroupLabel
            className={getModelGroupLabelClassName(provider)}
            data-model-picker-group-label={provider}
          >
            {group.label}
          </MenuGroupLabel>
        ) : null}
        {renderModelRadioItems(provider, group.items)}
        {groupIndex < groups.length - 1 ? <MenuDivider /> : null}
      </div>
    ));
  };

  const renderSearchableModelPanel = (
    provider: ProviderKind,
    value: string,
    onValueChange: (value: string) => void,
  ) => {
    const query = modelSearchByProvider[provider];
    const filteredOptions = filterModelOptions(props.modelOptionsByProvider[provider], query);
    const hasFilteredOptions = filteredOptions.length > 0;

    return (
      <div
        className="grid min-h-0 max-h-(--available-height) grid-rows-[auto_minmax(0,1fr)]"
        data-model-picker-panel={provider}
      >
        <div className="border-b p-1">
          <Input
            className="rounded-md font-sans"
            data-model-picker-search={provider}
            onChange={(event) => setProviderSearchQuery(provider, event.target.value)}
            onKeyDown={stopModelSearchInputKeyPropagation}
            placeholder="Search models..."
            size="sm"
            type="search"
            value={query}
          />
        </div>
        <ModelPickerList provider={provider}>
          {hasFilteredOptions ? (
            <MenuGroup className={provider === "opencode" ? "pb-1" : "p-1"}>
              <MenuRadioGroup value={value} onValueChange={onValueChange}>
                {renderModelGroups(provider, filteredOptions)}
              </MenuRadioGroup>
            </MenuGroup>
          ) : (
            <div className="p-1">
              <div className="px-3 py-2 text-muted-foreground text-sm">No models found.</div>
            </div>
          )}
        </ModelPickerList>
      </div>
    );
  };

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        if (props.disabled) {
          clearModelSearchQueries();
          setIsMenuOpen(false);
          return;
        }
        if (!open) {
          clearModelSearchQueries();
        }
        setIsMenuOpen(open);
      }}
    >
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant={props.triggerVariant ?? "ghost"}
            data-chat-provider-model-picker="true"
            className={cn(
              "min-w-0 justify-start overflow-hidden whitespace-nowrap px-2 text-muted-foreground/70 hover:text-foreground/80 [&_svg]:mx-0",
              props.compact ? "max-w-42 shrink-0" : "max-w-48 shrink sm:max-w-56 sm:px-3",
              props.triggerClassName,
            )}
            disabled={props.disabled}
          />
        }
      >
        <span
          className={cn(
            "flex min-w-0 w-full box-border items-center gap-2 overflow-hidden",
            props.compact ? "max-w-36 sm:pl-1" : undefined,
          )}
        >
          <ProviderIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0",
              providerIconClassName(activeProvider, "text-muted-foreground/70"),
              props.activeProviderIconClassName,
            )}
          />
          <span className="min-w-0 flex-1 truncate">{selectedModelLabel}</span>
          <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
        </span>
      </MenuTrigger>
      <MenuPopup
        align="start"
        className={props.lockedProvider !== null ? MODEL_PANEL_POPUP_CLASS_NAME : undefined}
        {...(props.lockedProvider !== null ? { viewportClassName: "overflow-hidden p-0" } : {})}
      >
        {props.lockedProvider !== null ? (
          renderSearchableModelPanel(props.lockedProvider, props.model, (value) =>
            handleModelChange(props.lockedProvider!, value),
          )
        ) : (
          <>
            {AVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              const liveProvider = props.providers
                ? getProviderSnapshot(props.providers, option.value)
                : undefined;
              if (liveProvider && liveProvider.status !== "ready") {
                const unavailableLabel = !liveProvider.enabled
                  ? "Disabled"
                  : !liveProvider.installed
                    ? "Not installed"
                    : "Unavailable";
                return (
                  <MenuItem key={option.value} disabled>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0 opacity-80",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    <span>{option.label}</span>
                    <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                      {unavailableLabel}
                    </span>
                  </MenuItem>
                );
              }

              return (
                <MenuSub key={option.value}>
                  <MenuSubTrigger>
                    <OptionIcon
                      aria-hidden="true"
                      className={cn(
                        "size-4 shrink-0",
                        providerIconClassName(option.value, "text-muted-foreground/85"),
                      )}
                    />
                    {option.label}
                  </MenuSubTrigger>
                  <MenuSubPopup
                    className={MODEL_PANEL_POPUP_CLASS_NAME}
                    sideOffset={4}
                    viewportClassName="overflow-hidden p-0"
                  >
                    {renderSearchableModelPanel(
                      option.value,
                      props.provider === option.value ? props.model : "",
                      (value) => handleModelChange(option.value, value),
                    )}
                  </MenuSubPopup>
                </MenuSub>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length > 0 && <MenuDivider />}
            {UNAVAILABLE_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = PROVIDER_ICON_BY_PROVIDER[option.value];
              return (
                <MenuItem key={option.value} disabled>
                  <OptionIcon
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground/85 opacity-80"
                  />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
            {UNAVAILABLE_PROVIDER_OPTIONS.length === 0 && <MenuDivider />}
            {COMING_SOON_PROVIDER_OPTIONS.map((option) => {
              const OptionIcon = option.icon;
              return (
                <MenuItem key={option.id} disabled>
                  <OptionIcon aria-hidden="true" className="size-4 shrink-0 opacity-80" />
                  <span>{option.label}</span>
                  <span className="ms-auto text-[11px] text-muted-foreground/80 uppercase tracking-[0.08em]">
                    Coming soon
                  </span>
                </MenuItem>
              );
            })}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
});
