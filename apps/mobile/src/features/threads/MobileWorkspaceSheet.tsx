import type { VcsRef } from "@t3tools/client-runtime";
import { SymbolView } from "expo-symbols";
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

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { branchBadgeLabel } from "./new-task-flow-provider";

type WorkspaceMode = "local" | "worktree";

export function MobileWorkspaceSheet(props: {
  readonly visible: boolean;
  readonly workspaceMode: WorkspaceMode;
  readonly selectedBranchName: string | null;
  readonly branchQuery: string;
  readonly branchesLoading: boolean;
  readonly branches: ReadonlyArray<VcsRef>;
  readonly selectedProject: Parameters<typeof branchBadgeLabel>[0]["project"];
  readonly onClose: () => void;
  readonly onSelectWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly onChangeBranchQuery: (value: string) => void;
  readonly onSelectBranch: (branch: VcsRef) => void;
}) {
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const backdropColor = isDarkMode ? "rgba(0,0,0,0.62)" : "rgba(10,10,10,0.28)";
  const panelColor = useThemeColor("--color-sheet");
  const borderColor = useThemeColor("--color-border");
  const foregroundColor = useThemeColor("--color-foreground");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const subtleColor = useThemeColor("--color-subtle");
  const iconColor = useThemeColor("--color-icon");
  const iconSubtleColor = useThemeColor("--color-icon-subtle");
  const primaryColor = useThemeColor("--color-primary");

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
            <Text className="text-foreground text-[22px] font-t3-bold">Workspace</Text>
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
              onPress={props.onClose}
            >
              <SymbolView name="xmark" size={14} tintColor={String(iconColor)} type="monochrome" />
            </Pressable>
          </View>

          <View className="pb-5">
            <Text className="px-1 pb-2 text-[13px] font-t3-bold uppercase text-foreground-muted">
              Mode
            </Text>
            <View className="flex-row gap-2">
              {(["local", "worktree"] as const).map((mode) => {
                const selected = props.workspaceMode === mode;
                return (
                  <Pressable
                    key={mode}
                    className="h-11 flex-1 items-center justify-center rounded-full border"
                    style={{
                      borderColor: selected ? String(primaryColor) : String(borderColor),
                      backgroundColor: selected ? "rgba(59,130,246,0.12)" : String(subtleColor),
                    }}
                    onPress={() => props.onSelectWorkspaceMode(mode)}
                  >
                    <Text className="text-[14px] font-t3-bold text-foreground">
                      {mode === "local" ? "Local" : "Worktree"}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
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
              value={props.branchQuery}
              onChangeText={props.onChangeBranchQuery}
              placeholder="Search branches"
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
            {props.branches.map((branch) => {
              const selected = props.selectedBranchName === branch.name;
              const badge = branchBadgeLabel({ branch, project: props.selectedProject });
              return (
                <Pressable
                  key={branch.name}
                  className="flex-row items-center gap-3 px-1 py-3"
                  onPress={() => {
                    props.onSelectBranch(branch);
                    props.onClose();
                  }}
                >
                  <View className="h-10 w-10 items-center justify-center rounded-full bg-subtle">
                    <SymbolView
                      name={
                        branch.worktreePath
                          ? "folder.badge.gearshape"
                          : "point.topleft.down.curvedto.point.bottomright.up"
                      }
                      size={17}
                      tintColor={String(iconColor)}
                      type="monochrome"
                    />
                  </View>
                  <View className="min-w-0 flex-1 gap-0.5">
                    <Text className="text-foreground text-[15px] font-t3-bold" numberOfLines={1}>
                      {branch.name}
                    </Text>
                    {badge ? (
                      <Text
                        className="text-foreground-muted text-[12px] uppercase"
                        numberOfLines={1}
                      >
                        {badge}
                      </Text>
                    ) : null}
                  </View>
                  {selected ? (
                    <SymbolView
                      name="checkmark"
                      size={15}
                      tintColor={String(primaryColor)}
                      type="monochrome"
                    />
                  ) : null}
                </Pressable>
              );
            })}
            {props.branches.length === 0 ? (
              <View className="items-center px-4 py-12">
                <Text className="text-center text-[14px] font-medium text-foreground-muted">
                  {props.branchesLoading ? "Loading branches..." : "No branches found."}
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
