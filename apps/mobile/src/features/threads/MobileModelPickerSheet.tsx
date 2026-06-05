import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
  useColorScheme,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ModelSelection } from "@t3tools/contracts";

import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import {
  favoriteKey,
  groupByProvider,
  sortModelOptionsForMobile,
  type ModelFavorite,
  type ModelOption,
} from "../../lib/modelOptions";
import { useThemeColor } from "../../lib/useThemeColor";

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function modelMatchesQuery(option: ModelOption, query: string): boolean {
  if (!query) {
    return true;
  }

  return [
    option.label,
    option.selection.model,
    option.subtitle,
    option.providerLabel,
    option.providerDriver,
    option.subProvider,
  ].some((value) => value?.toLowerCase().includes(query));
}

function isSelected(option: ModelOption, selection: ModelSelection | null): boolean {
  return (
    selection !== null &&
    option.selection.instanceId === selection.instanceId &&
    option.selection.model === selection.model
  );
}

function reorderFavorite(
  favorites: ReadonlyArray<ModelFavorite>,
  visibleFavorites: ReadonlyArray<ModelOption>,
  option: ModelOption,
  direction: -1 | 1,
): ModelFavorite[] {
  const visibleIndex = visibleFavorites.findIndex((favorite) => favorite.key === option.key);
  const swapWith = visibleFavorites[visibleIndex + direction];
  if (visibleIndex < 0 || !swapWith) {
    return [...favorites];
  }

  const currentIndex = favorites.findIndex((favorite) => favoriteKey(favorite) === option.key);
  const swapIndex = favorites.findIndex((favorite) => favoriteKey(favorite) === swapWith.key);
  if (currentIndex < 0 || swapIndex < 0) {
    return [...favorites];
  }

  const next = [...favorites];
  [next[currentIndex], next[swapIndex]] = [next[swapIndex]!, next[currentIndex]!];
  return next;
}

export function MobileModelPickerSheet(props: {
  readonly visible: boolean;
  readonly title?: string;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly favorites: ReadonlyArray<ModelFavorite>;
  readonly onClose: () => void;
  readonly onSelectModel: (selection: ModelSelection) => void;
  readonly onFavoritesChange: (favorites: ReadonlyArray<ModelFavorite>) => void;
}) {
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const [query, setQuery] = useState("");
  const backdropColor = isDarkMode ? "rgba(0,0,0,0.62)" : "rgba(10,10,10,0.28)";
  const panelColor = useThemeColor("--color-sheet");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const primaryColor = useThemeColor("--color-primary");
  const normalizedQuery = normalizeSearch(query);

  const favoritesSet = useMemo(
    () => new Set(props.favorites.map((favorite) => favoriteKey(favorite))),
    [props.favorites],
  );
  const filteredOptions = useMemo(
    () =>
      props.modelOptions.filter((option) =>
        modelMatchesQuery(
          {
            ...option,
            isFavorite: favoritesSet.has(option.key),
          },
          normalizedQuery,
        ),
      ),
    [favoritesSet, normalizedQuery, props.modelOptions],
  );
  const sortedOptions = useMemo(
    () => sortModelOptionsForMobile(filteredOptions, props.favorites),
    [filteredOptions, props.favorites],
  );
  const favoriteOptions = useMemo(
    () => sortedOptions.filter((option) => favoritesSet.has(option.key)),
    [favoritesSet, sortedOptions],
  );
  const showFavorites = favoriteOptions.length > 0;
  const providerOptions = useMemo(
    () =>
      showFavorites
        ? sortedOptions.filter((option) => !favoritesSet.has(option.key))
        : sortedOptions,
    [favoritesSet, showFavorites, sortedOptions],
  );
  const providerGroups = useMemo(() => groupByProvider(providerOptions), [providerOptions]);

  const toggleFavorite = (option: ModelOption) => {
    if (favoritesSet.has(option.key)) {
      props.onFavoritesChange(
        props.favorites.filter((favorite) => favoriteKey(favorite) !== option.key),
      );
      return;
    }

    props.onFavoritesChange([
      ...props.favorites,
      { provider: option.selection.instanceId, model: option.selection.model },
    ]);
  };

  const selectModel = (option: ModelOption) => {
    props.onSelectModel(option.selection);
    props.onClose();
  };

  const renderRow = (option: ModelOption, section: "favorites" | "provider", index: number) => {
    const selected = isSelected(option, props.selectedModel);
    const favorite = favoritesSet.has(option.key);
    const canMoveUp = section === "favorites" && index > 0;
    const canMoveDown = section === "favorites" && index < favoriteOptions.length - 1;

    return (
      <Pressable
        key={`${section}:${option.key}`}
        className="flex-row items-center gap-3 px-1 py-3"
        onPress={() => selectModel(option)}
      >
        <View className="h-10 w-10 items-center justify-center rounded-full bg-subtle">
          <ProviderIcon provider={option.providerDriver} size={17} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-foreground text-[15px] font-t3-bold" numberOfLines={1}>
            {option.label}
          </Text>
          <Text className="text-foreground-muted text-[12px] leading-[17px]" numberOfLines={1}>
            {option.subtitle}
          </Text>
        </View>
        {selected ? (
          <SymbolView
            name="checkmark"
            size={15}
            tintColor={String(primaryColor)}
            type="monochrome"
          />
        ) : null}
        {section === "favorites" ? (
          <View className="flex-row items-center gap-1">
            <Pressable
              className="h-8 w-8 items-center justify-center rounded-full"
              disabled={!canMoveUp}
              style={{ opacity: canMoveUp ? 1 : 0.3 }}
              onPress={(event) => {
                event.stopPropagation();
                props.onFavoritesChange(
                  reorderFavorite(props.favorites, favoriteOptions, option, -1),
                );
              }}
            >
              <SymbolView
                name="chevron.up"
                size={13}
                tintColor={String(iconSubtleColor)}
                type="monochrome"
              />
            </Pressable>
            <Pressable
              className="h-8 w-8 items-center justify-center rounded-full"
              disabled={!canMoveDown}
              style={{ opacity: canMoveDown ? 1 : 0.3 }}
              onPress={(event) => {
                event.stopPropagation();
                props.onFavoritesChange(
                  reorderFavorite(props.favorites, favoriteOptions, option, 1),
                );
              }}
            >
              <SymbolView
                name="chevron.down"
                size={13}
                tintColor={String(iconSubtleColor)}
                type="monochrome"
              />
            </Pressable>
          </View>
        ) : null}
        <Pressable
          className="h-9 w-9 items-center justify-center rounded-full"
          onPress={(event) => {
            event.stopPropagation();
            toggleFavorite(option);
          }}
        >
          <SymbolView
            name={favorite ? "star.fill" : "star"}
            size={16}
            tintColor={favorite ? "#eab308" : String(iconSubtleColor)}
            type="monochrome"
          />
        </Pressable>
      </Pressable>
    );
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={props.visible}
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        className="flex-1 justify-end"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            backgroundColor: backdropColor,
          }}
          onPress={props.onClose}
        />
        <View
          style={{
            maxHeight: "84%",
            paddingTop: 14,
            paddingBottom: Math.max(insets.bottom, 14),
            paddingHorizontal: 16,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderColor: String(borderColor),
            backgroundColor: String(panelColor),
          }}
        >
          <View className="flex-row items-center justify-between pb-3">
            <Text className="text-foreground text-[22px] font-t3-bold">
              {props.title ?? "Model"}
            </Text>
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
              onPress={props.onClose}
            >
              <SymbolView name="xmark" size={14} tintColor={String(iconColor)} type="monochrome" />
            </Pressable>
          </View>
          <View
            className="mb-3 flex-row items-center gap-2 rounded-full px-3"
            style={{
              minHeight: 44,
              backgroundColor: String(subtleColor),
              borderWidth: 1,
              borderColor: String(borderColor),
            }}
          >
            <SymbolView
              name="magnifyingglass"
              size={15}
              tintColor={String(iconSubtleColor)}
              type="monochrome"
            />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search models"
              placeholderTextColor={String(mutedColor)}
              autoCapitalize="none"
              autoCorrect={false}
              style={{
                flex: 1,
                minHeight: 42,
                color: String(foregroundColor),
                fontSize: 15,
                fontFamily: "DMSans_400Regular",
              }}
            />
          </View>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {showFavorites ? (
              <View className="pb-3">
                <Text
                  className="px-1 pb-1 text-[12px] font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.9 }}
                >
                  Favorites
                </Text>
                {favoriteOptions.map((option, index) => renderRow(option, "favorites", index))}
              </View>
            ) : null}
            {providerGroups.map((group) => (
              <View key={group.providerKey} className="pb-3">
                <Text
                  className="px-1 pb-1 text-[12px] font-t3-bold uppercase text-foreground-muted"
                  style={{ letterSpacing: 0.9 }}
                >
                  {group.providerLabel}
                </Text>
                {group.models.map((option, index) => renderRow(option, "provider", index))}
              </View>
            ))}
            {sortedOptions.length === 0 ? (
              <View className="items-center px-4 py-12">
                <Text className="text-center text-[14px] font-medium text-foreground-muted">
                  No models found.
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
