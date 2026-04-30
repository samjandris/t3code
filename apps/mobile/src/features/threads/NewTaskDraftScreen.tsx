import { MenuView } from "@react-native-menu/menu";
import { useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import { TextInputWrapper } from "expo-paste-input";
import { useCallback, useEffect, useMemo } from "react";
import { Pressable, View, useColorScheme } from "react-native";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import {
  EnvironmentId,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPill } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";

import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import {
  buildModelMenuActions,
  findServerProvider,
  formatProviderOptionValue,
  getModelOptionDescriptors,
  getModelSelectionDriver,
  getModelSelectionProviderKey,
} from "../../lib/modelOptions";
import { buildThreadRoutePath } from "../../lib/routes";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useNativePaste } from "../../lib/useNativePaste";
import { branchBadgeLabel, useNewTaskFlow } from "./new-task-flow-provider";
import { useProjectActions } from "./use-project-actions";

function withModelOptions(
  selection: ModelSelection,
  options: ReadonlyArray<ProviderOptionSelection>,
): ModelSelection {
  return {
    ...selection,
    options: options.filter((option) => option.value !== undefined),
  };
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
}) {
  const { projects, serverConfigByEnvironmentId } = useRemoteCatalog();
  const { onCreateThreadWithOptions } = useProjectActions();
  const flow = useNewTaskFlow();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const keyboard = useAnimatedKeyboard();
  const containerAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value,
  }));
  const controlsBottomPadding = useAnimatedStyle(() => ({
    paddingBottom: keyboard.height.value > 0 ? 4 : Math.max(insets.bottom, 10),
  }));
  const { logicalProjects, selectedProject, setProject } = flow;
  const selectedServerConfig = selectedProject
    ? (serverConfigByEnvironmentId[selectedProject.environmentId] ?? null)
    : null;
  const selectedProviderStatus = findServerProvider(
    selectedServerConfig,
    getModelSelectionProviderKey(flow.selectedModel),
  );
  const selectedProviderDriver = getModelSelectionDriver(selectedServerConfig, flow.selectedModel);
  const selectedModelWithOptions = flow.selectedModel
    ? withModelOptions(flow.selectedModel, flow.modelOptionSelections)
    : null;

  const iconColor = useThemeColor("--color-icon");
  const borderColor = useThemeColor("--color-border");

  useEffect(() => {
    if (props.initialProjectRef?.environmentId && props.initialProjectRef?.projectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === props.initialProjectRef?.environmentId &&
            project.id === props.initialProjectRef?.projectId,
        ) ?? null;

      if (directProject) {
        setProject(directProject);
        return;
      }
    }

    if (selectedProject) {
      return;
    }

    if (logicalProjects.length === 1) {
      setProject(logicalProjects[0]!.project);
      return;
    }

    router.replace("/new");
  }, [
    logicalProjects,
    projects,
    props.initialProjectRef?.environmentId,
    props.initialProjectRef?.projectId,
    router,
    selectedProject,
    setProject,
  ]);

  useEffect(() => {
    if (!selectedProject) {
      return;
    }
    void flow.loadBranches();
  }, [flow, selectedProject]);

  const environmentMenuActions = useMemo(
    () =>
      flow.environments.map((environment) => ({
        id: `environment:${environment.environmentId}`,
        title: environment.environmentLabel,
        state:
          flow.selectedEnvironmentId === environment.environmentId ? ("on" as const) : undefined,
      })),
    [flow.environments, flow.selectedEnvironmentId],
  );

  const modelMenuActions = useMemo(
    () => buildModelMenuActions(flow.providerGroups, flow.selectedModel),
    [flow.providerGroups, flow.selectedModel],
  );

  const optionsMenuActions = useMemo(() => {
    const modelOptionDescriptors = getModelOptionDescriptors(
      selectedServerConfig,
      selectedModelWithOptions,
    );
    const modelActions = modelOptionDescriptors.map((descriptor) => {
      if (descriptor.type === "boolean") {
        const currentValue = getProviderOptionCurrentValue(descriptor) === true;
        return {
          id: `model-option:${descriptor.id}`,
          title: descriptor.label,
          subtitle: formatProviderOptionValue(descriptor),
          subactions: ([false, true] as const).map((value) => ({
            id: `model-option:${descriptor.id}:${value ? "on" : "off"}`,
            title: value ? "On" : "Off",
            state: currentValue === value ? ("on" as const) : undefined,
          })),
        };
      }

      const currentValue = getProviderOptionCurrentValue(descriptor);
      return {
        id: `model-option:${descriptor.id}`,
        title: descriptor.label,
        subtitle: formatProviderOptionValue(descriptor),
        subactions: descriptor.options.map((option) => ({
          id: `model-option:${descriptor.id}:${option.id}`,
          title: `${option.label}${option.isDefault ? " (default)" : ""}`,
          state: currentValue === option.id ? ("on" as const) : undefined,
        })),
      };
    });

    return [
      ...modelActions,
      {
        id: "options-runtime",
        title: "Runtime",
        subtitle:
          flow.runtimeMode === "approval-required"
            ? "Approve actions"
            : flow.runtimeMode === "auto-accept-edits"
              ? "Auto-accept edits"
              : "Full access",
        subactions: [
          { id: "options:runtime:approval-required", title: "Approve actions" },
          { id: "options:runtime:auto-accept-edits", title: "Auto-accept edits" },
          { id: "options:runtime:full-access", title: "Full access" },
        ].map((option) => {
          const value = option.id.replace("options:runtime:", "");
          return {
            id: option.id,
            title: option.title,
            state: flow.runtimeMode === value ? ("on" as const) : undefined,
          };
        }),
      },
      ...(selectedProviderStatus?.showInteractionModeToggle === false
        ? []
        : [
            {
              id: "options-interaction",
              title: "Interaction",
              subtitle: flow.interactionMode === "plan" ? "Plan" : "Default",
              subactions: [
                { id: "options:interaction:default", title: "Default" },
                { id: "options:interaction:plan", title: "Plan" },
              ].map((option) => {
                const value = option.id.replace("options:interaction:", "");
                return {
                  id: option.id,
                  title: option.title,
                  state: flow.interactionMode === value ? ("on" as const) : undefined,
                };
              }),
            },
          ]),
    ];
  }, [
    flow.interactionMode,
    flow.runtimeMode,
    selectedModelWithOptions,
    selectedProviderStatus?.showInteractionModeToggle,
    selectedServerConfig,
  ]);

  const workspaceMenuActions = useMemo(() => {
    const branchActions =
      flow.availableBranches.length === 0
        ? [
            {
              id: "workspace:branch:none",
              title: flow.branchesLoading ? "Loading branches…" : "No branches available",
              attributes: { disabled: true },
            },
          ]
        : flow.availableBranches.slice(0, 12).map((branch) => {
            const badge = branchBadgeLabel({
              branch,
              project: flow.selectedProject,
            });

            return {
              id: `workspace:branch:${branch.name}`,
              title: branch.name,
              subtitle: badge ? badge.toUpperCase() : undefined,
              state: flow.selectedBranchName === branch.name ? ("on" as const) : undefined,
            };
          });

    return [
      {
        id: "workspace:mode",
        title: "Mode",
        subtitle: flow.workspaceMode === "local" ? "Local" : "Worktree",
        subactions: (["local", "worktree"] as const).map((value) => ({
          id: `workspace:mode:${value}`,
          title: value === "local" ? "Local" : "Worktree",
          state: flow.workspaceMode === value ? ("on" as const) : undefined,
        })),
      },
      {
        id: "workspace:branch",
        title: "Branch",
        subtitle: flow.selectedBranchName ?? "Choose branch",
        subactions: branchActions,
      },
    ];
  }, [
    flow.availableBranches,
    flow.branchesLoading,
    flow.selectedBranchName,
    flow.selectedProject,
    flow.workspaceMode,
  ]);

  function handleModelMenuAction(event: string) {
    if (!event.startsWith("model:")) {
      return;
    }
    // Defer state update so the native menu dismiss animation completes
    // before re-rendering the menu actions (prevents submenu jump).
    setTimeout(() => {
      flow.setSelectedModelKey(event.slice("model:".length));
    }, 150);
  }

  function handleEnvironmentMenuAction(event: string) {
    if (!event.startsWith("environment:")) {
      return;
    }
    flow.selectEnvironment(EnvironmentId.make(event.slice("environment:".length)));
  }

  function handleOptionsMenuAction(event: string) {
    if (event.startsWith("model-option:")) {
      const [, id, rawValue] = event.split(":");
      const descriptor = getModelOptionDescriptors(
        selectedServerConfig,
        selectedModelWithOptions,
      ).find((candidate) => candidate.id === id);
      if (!id || !rawValue || !descriptor) {
        return;
      }
      flow.setModelOptionSelection(
        id,
        descriptor.type === "boolean" ? rawValue === "on" : rawValue,
      );
      return;
    }
    if (event.startsWith("options:runtime:")) {
      flow.setRuntimeMode(
        event.slice("options:runtime:".length) as Parameters<typeof flow.setRuntimeMode>[0],
      );
      return;
    }
    if (event.startsWith("options:interaction:")) {
      flow.setInteractionMode(
        event.slice("options:interaction:".length) as Parameters<typeof flow.setInteractionMode>[0],
      );
    }
  }

  function handleWorkspaceMenuAction(event: string) {
    if (event.startsWith("workspace:mode:")) {
      flow.setWorkspaceMode(
        event.slice("workspace:mode:".length) as Parameters<typeof flow.setWorkspaceMode>[0],
      );
      return;
    }
    if (event.startsWith("workspace:branch:")) {
      const branchName = event.slice("workspace:branch:".length);
      const branch = flow.availableBranches.find((candidate) => candidate.name === branchName);
      if (branch) {
        flow.selectBranch(branch);
      }
    }
  }

  async function handlePickImages(): Promise<void> {
    const result = await pickComposerImages({ existingCount: flow.attachments.length });
    if (result.images.length > 0) {
      flow.appendAttachments(result.images);
    }
  }

  const handleNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: flow.attachments.length,
        });
        if (images.length > 0) {
          flow.appendAttachments(images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", error);
      }
    },
    [flow],
  );

  const handleNativePaste = useNativePaste((uris) => {
    void handleNativePasteImages(uris);
  });

  async function handleStart(): Promise<void> {
    if (
      !flow.selectedProject ||
      !flow.selectedModel ||
      flow.prompt.trim().length === 0 ||
      flow.submitting ||
      (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
    ) {
      return;
    }

    flow.setSubmitting(true);
    try {
      const modelWithOptions: ModelSelection =
        selectedModelWithOptions !== null
          ? withModelOptions(
              flow.selectedModel,
              buildProviderOptionSelectionsFromDescriptors(
                getModelOptionDescriptors(selectedServerConfig, selectedModelWithOptions),
              ) ?? [],
            )
          : flow.selectedModel;

      const createdThread = await onCreateThreadWithOptions({
        project: flow.selectedProject,
        modelSelection: modelWithOptions,
        envMode: flow.workspaceMode,
        branch: flow.selectedBranchName,
        worktreePath: flow.workspaceMode === "worktree" ? null : flow.selectedWorktreePath,
        runtimeMode: flow.runtimeMode,
        interactionMode: flow.interactionMode,
        initialMessageText: flow.prompt.trim(),
        initialAttachments: flow.attachments,
      });

      if (createdThread) {
        router.replace(buildThreadRoutePath(createdThread));
      }
    } finally {
      flow.setSubmitting(false);
    }
  }

  if (!selectedProject) {
    return (
      <View className="flex-1 bg-sheet">
        <View style={{ minHeight: 16, paddingTop: 8 }} />
        <View className="items-center gap-1 px-5 pb-3 pt-4">
          <Text
            className="text-[12px] font-t3-bold uppercase text-foreground-muted"
            style={{ letterSpacing: 1 }}
          >
            New task
          </Text>
          <Text className="text-[28px] font-t3-bold">Loading task</Text>
        </View>
      </View>
    );
  }

  return (
    <Animated.View className="flex-1 bg-sheet" style={containerAnimatedStyle}>
      <View style={{ minHeight: 16, paddingTop: 8 }} />

      <View className="items-center gap-1 px-5 pb-3 pt-4">
        {flow.logicalProjects.length > 1 ? (
          <Pressable
            className="absolute left-3 top-4 h-9 w-9 items-center justify-center rounded-full bg-subtle"
            style={{ zIndex: 1 }}
            onPress={() => router.back()}
          >
            <SymbolView
              name="chevron.left"
              size={16}
              tintColor={iconColor}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        ) : null}
        <Text
          className="text-[12px] font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          New task
        </Text>
        <Text className="text-[28px] font-t3-bold">{selectedProject.title}</Text>
      </View>

      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8 }}>
        <TextInputWrapper onPaste={(payload) => void handleNativePaste(payload)}>
          <TextInput
            multiline
            value={flow.prompt}
            onChangeText={flow.setPrompt}
            placeholder={`Describe a coding task in ${selectedProject.title}`}
            textAlignVertical="top"
            className="flex-1 border-0 bg-transparent text-[18px] leading-[28px]"
          />
        </TextInputWrapper>
      </View>

      <Animated.View
        style={[
          {
            borderTopWidth: 1,
            borderTopColor: borderColor,
          },
          controlsBottomPadding,
        ]}
      >
        {flow.attachments.length > 0 ? (
          <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
            <ComposerAttachmentStrip
              attachments={flow.attachments}
              onRemove={flow.removeAttachment}
              imageSize={88}
              imageBorderRadius={20}
            />
          </View>
        ) : null}
        <View className="flex-row items-center justify-between gap-2 px-4 pb-1 pt-4">
          <ControlPill icon="plus" onPress={() => void handlePickImages()} />
          <MenuView
            actions={modelMenuActions}
            onPressAction={({ nativeEvent }) => handleModelMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill iconNode={<ProviderIcon provider={selectedProviderDriver} size={16} />} />
          </MenuView>
          <MenuView
            actions={optionsMenuActions}
            onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill icon="slider.horizontal.3" />
          </MenuView>
          <MenuView
            actions={environmentMenuActions}
            onPressAction={({ nativeEvent }) => handleEnvironmentMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill icon="desktopcomputer" />
          </MenuView>
          <MenuView
            actions={workspaceMenuActions}
            onPressAction={({ nativeEvent }) => handleWorkspaceMenuAction(nativeEvent.event)}
            themeVariant={isDarkMode ? "dark" : "light"}
          >
            <ControlPill icon="point.topleft.down.curvedto.point.bottomright.up" />
          </MenuView>
          <ControlPill
            icon="arrow.up"
            label={flow.submitting ? "Starting" : "Start"}
            onPress={() => void handleStart()}
            variant="primary"
            disabled={
              !flow.selectedProject ||
              !flow.selectedModel ||
              flow.prompt.trim().length === 0 ||
              flow.submitting ||
              (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
            }
          />
        </View>
      </Animated.View>
    </Animated.View>
  );
}
