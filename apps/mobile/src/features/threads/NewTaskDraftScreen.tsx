import { useRouter } from "expo-router";
import { TextInputWrapper } from "expo-paste-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { InteractionManager, View, type TextInput as RNTextInput } from "react-native";
import { KeyboardStickyView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import { EnvironmentId, type ModelSelection } from "@t3tools/contracts";

import { AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";

import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { modelOptionKey } from "../../lib/modelOptions";
import {
  buildModelTraitMenuActions,
  getModelTraitDescriptors,
  updateModelSelectionTrait,
} from "../../lib/modelTraits";
import { buildThreadRoutePath } from "../../lib/routes";
import { useRemoteCatalog } from "../../state/use-remote-catalog";
import { useNativePaste } from "../../lib/useNativePaste";
import { MobileComposerOptionsSheet } from "./MobileComposerOptionsSheet";
import { MobileModelPickerSheet } from "./MobileModelPickerSheet";
import { MobileWorkspaceSheet } from "./MobileWorkspaceSheet";
import { NewTaskSheetHeader } from "./NewTaskSheetHeader";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { useProjectActions } from "./use-project-actions";
import { useMobileModelFavorites } from "./useMobileModelFavorites";

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
}) {
  const { projects } = useRemoteCatalog();
  const { onCreateThreadWithOptions } = useProjectActions();
  const flow = useNewTaskFlow();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = isKeyboardVisible ? 8 : Math.max(insets.bottom, 10);
  const { logicalProjects, selectedProject, setProject } = flow;
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [optionsSheetVisible, setOptionsSheetVisible] = useState(false);
  const [workspaceSheetVisible, setWorkspaceSheetVisible] = useState(false);
  const promptInputRef = useRef<RNTextInput>(null);
  const { favorites: modelFavorites, updateFavorites: updateModelFavorites } =
    useMobileModelFavorites();

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

  useEffect(() => {
    if (!selectedProject) {
      return;
    }

    let focusFrame: ReturnType<typeof requestAnimationFrame> | null = null;
    const interaction = InteractionManager.runAfterInteractions(() => {
      focusFrame = requestAnimationFrame(() => promptInputRef.current?.focus());
    });

    return () => {
      interaction.cancel();
      if (focusFrame !== null) {
        cancelAnimationFrame(focusFrame);
      }
    };
  }, [selectedProject]);

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

  const modelTraitDescriptors = useMemo(
    () =>
      getModelTraitDescriptors({
        option: flow.selectedModelOption,
        selections:
          flow.selectedModelOptions.length > 0
            ? flow.selectedModelOptions
            : flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption, flow.selectedModelOptions],
  );
  const modelTraitActions = useMemo(
    () => buildModelTraitMenuActions(modelTraitDescriptors),
    [modelTraitDescriptors],
  );

  const optionsMenuActions = useMemo(
    () => [
      ...modelTraitActions,
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
    ],
    [modelTraitActions, flow.interactionMode, flow.runtimeMode],
  );

  function handleEnvironmentMenuAction(event: string) {
    if (!event.startsWith("environment:")) {
      return;
    }
    flow.selectEnvironment(EnvironmentId.make(event.slice("environment:".length)));
  }

  function handleOptionsMenuAction(event: string) {
    if (event.startsWith("options:trait:") && flow.selectedModel) {
      const updated = updateModelSelectionTrait({
        selection: {
          ...flow.selectedModel,
          ...(flow.selectedModelOptions.length > 0 ? { options: flow.selectedModelOptions } : {}),
        },
        descriptors: modelTraitDescriptors,
        event,
      });
      if (updated) {
        flow.setSelectedModelOptions(updated.options ?? []);
      }
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
        flow.selectedModelOptions.length > 0
          ? { ...flow.selectedModel, options: flow.selectedModelOptions }
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
        <NewTaskSheetHeader title="Loading task" />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <NewTaskSheetHeader
        title={selectedProject.title}
        control={
          flow.logicalProjects.length > 1
            ? { icon: "chevron.left", onPress: () => router.back() }
            : undefined
        }
      />

      <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 8 }}>
        <TextInputWrapper
          onPaste={(payload) => void handleNativePaste(payload)}
          style={{ flex: 1 }}
        >
          <TextInput
            ref={promptInputRef}
            autoFocus
            multiline
            value={flow.prompt}
            onChangeText={flow.setPrompt}
            placeholder={`Describe a coding task in ${selectedProject.title}`}
            textAlignVertical="top"
            className="h-full flex-1 border-0 bg-transparent text-[18px] leading-[28px]"
            style={{ flex: 1 }}
          />
        </TextInputWrapper>
      </View>

      <KeyboardStickyView>
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: borderColor,
            paddingBottom: controlsBottomPadding,
          }}
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
          <View className="flex-row items-center justify-between gap-2 px-4 pt-2">
            <ControlPill icon="plus" onPress={() => void handlePickImages()} />
            <ControlPill
              iconNode={
                <ProviderIcon provider={flow.selectedModelOption?.providerDriver} size={16} />
              }
              onPress={() => setModelPickerVisible(true)}
            />
            <ControlPill icon="slider.horizontal.3" onPress={() => setOptionsSheetVisible(true)} />
            <ControlPillMenu
              actions={environmentMenuActions}
              onPressAction={({ nativeEvent }) => handleEnvironmentMenuAction(nativeEvent.event)}
            >
              <ControlPill icon="desktopcomputer" />
            </ControlPillMenu>
            <ControlPill
              icon="point.topleft.down.curvedto.point.bottomright.up"
              onPress={() => setWorkspaceSheetVisible(true)}
            />
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
        </View>
      </KeyboardStickyView>
      <MobileModelPickerSheet
        visible={modelPickerVisible}
        modelOptions={flow.modelOptions}
        selectedModel={flow.selectedModel}
        favorites={modelFavorites}
        onClose={() => setModelPickerVisible(false)}
        onSelectModel={(selection) => flow.setSelectedModelKey(modelOptionKey(selection))}
        onFavoritesChange={updateModelFavorites}
      />
      <MobileComposerOptionsSheet
        visible={optionsSheetVisible}
        actions={optionsMenuActions}
        onClose={() => setOptionsSheetVisible(false)}
        onSelectAction={handleOptionsMenuAction}
      />
      <MobileWorkspaceSheet
        visible={workspaceSheetVisible}
        workspaceMode={flow.workspaceMode}
        selectedBranchName={flow.selectedBranchName}
        branchQuery={flow.branchQuery}
        branchesLoading={flow.branchesLoading}
        branches={flow.filteredBranches}
        selectedProject={flow.selectedProject}
        onClose={() => setWorkspaceSheetVisible(false)}
        onSelectWorkspaceMode={flow.setWorkspaceMode}
        onChangeBranchQuery={flow.setBranchQuery}
        onSelectBranch={flow.selectBranch}
      />
    </View>
  );
}
