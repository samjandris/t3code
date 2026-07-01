import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, InteractionManager, View, useColorScheme } from "react-native";
import { KeyboardAvoidingView, useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../../lib/useThemeColor";

import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId } from "@t3tools/contracts";

import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
  ComposerToolbarTrigger,
} from "../../components/ComposerToolbarTrigger";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";

import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { modelOptionKey } from "../../lib/modelOptions";
import {
  buildModelTraitMenuActions,
  getModelTraitDescriptors,
  updateModelSelectionTrait,
} from "../../lib/modelTraits";
import { buildThreadRoutePath } from "../../lib/routes";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { useProjects } from "../../state/entities";
import { MobileComposerOptionsSheet } from "./MobileComposerOptionsSheet";
import { MobileModelPickerSheet } from "./MobileModelPickerSheet";
import { MobileWorkspaceSheet } from "./MobileWorkspaceSheet";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { useCreateProjectThread } from "./use-project-actions";
import { useMobileModelFavorites } from "./useMobileModelFavorites";

function formatWorkspaceLabel(input: {
  readonly workspaceMode: string;
  readonly currentBranchName: string | null;
  readonly selectedBranchName: string | null;
}): string {
  const branchName = input.selectedBranchName ?? input.currentBranchName;
  if (input.workspaceMode === "worktree") {
    return branchName ? `New worktree · ${branchName}` : "New worktree";
  }
  return branchName ? `Current · ${branchName}` : "Current checkout";
}

export function NewTaskDraftScreen(props: {
  readonly initialProjectRef?: {
    readonly environmentId?: string;
    readonly projectId?: string;
  };
}) {
  const projects = useProjects();
  const createProjectThread = useCreateProjectThread();
  const flow = useNewTaskFlow();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = isKeyboardVisible ? 8 : Math.max(insets.bottom, 10);
  const { logicalProjects, selectedProject, setProject } = flow;
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [optionsSheetVisible, setOptionsSheetVisible] = useState(false);
  const [workspaceSheetVisible, setWorkspaceSheetVisible] = useState(false);
  const { favorites: modelFavorites, updateFavorites: updateModelFavorites } =
    useMobileModelFavorites();

  const borderColor = useThemeColor("--color-border");
  const sheetFadeOpaque = colorScheme === "dark" ? "rgba(14,14,14,0.98)" : "rgba(242,242,247,0.98)";
  const sheetFadeTransparent = colorScheme === "dark" ? "rgba(14,14,14,0)" : "rgba(242,242,247,0)";

  useEffect(() => {
    if (props.initialProjectRef?.environmentId && props.initialProjectRef?.projectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === props.initialProjectRef?.environmentId &&
            project.id === props.initialProjectRef?.projectId,
        ) ?? null;

      if (directProject) {
        if (
          selectedProject?.environmentId === directProject.environmentId &&
          selectedProject.id === directProject.id
        ) {
          return;
        }
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
      loadedBranchesProjectKeyRef.current = null;
      return;
    }
    const projectKey = `${selectedProject.environmentId}:${selectedProject.id}`;
    if (loadedBranchesProjectKeyRef.current === projectKey) {
      return;
    }
    loadedBranchesProjectKeyRef.current = projectKey;
    void flow.loadBranches();
  }, [flow.loadBranches, selectedProject]);

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
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption],
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
  const selectedEnvironmentLabel =
    flow.environments.find(
      (environment) => environment.environmentId === flow.selectedEnvironmentId,
    )?.environmentLabel ?? "Environment";
  const currentBranchName =
    flow.availableBranches.find((branch) => branch.current)?.name ??
    flow.availableBranches.find((branch) => branch.isDefault)?.name ??
    null;
  const workspaceLabel = useMemo(
    () =>
      formatWorkspaceLabel({
        currentBranchName,
        selectedBranchName: flow.selectedBranchName,
        workspaceMode: flow.workspaceMode,
      }),
    [currentBranchName, flow.selectedBranchName, flow.workspaceMode],
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
        selection: flow.selectedModel,
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

  async function handleStart(): Promise<void> {
    const selectedProject = flow.selectedProject;
    if (!selectedProject) {
      return;
    }
    const draft = getComposerDraftSnapshot(
      `new-task:${scopedProjectKey(selectedProject.environmentId, selectedProject.id)}`,
    );
    const modelSelection = draft.modelSelection ?? flow.selectedModel;
    const workspaceMode = draft.workspaceSelection?.mode ?? flow.workspaceMode;
    const selectedBranchName = draft.workspaceSelection?.branch ?? flow.selectedBranchName;
    const selectedWorktreePath =
      draft.workspaceSelection?.worktreePath ?? flow.selectedWorktreePath;
    const runtimeMode = draft.runtimeMode ?? flow.runtimeMode;
    const interactionMode = draft.interactionMode ?? flow.interactionMode;
    const initialMessageText = draft.text.trim();

    if (
      !modelSelection ||
      initialMessageText.length === 0 ||
      flow.submitting ||
      (workspaceMode === "worktree" && !selectedBranchName)
    ) {
      return;
    }

    flow.setSubmitting(true);
    const result = await createProjectThread({
      project: selectedProject,
      modelSelection,
      envMode: workspaceMode,
      branch: selectedBranchName,
      worktreePath: workspaceMode === "worktree" ? null : selectedWorktreePath,
      runtimeMode,
      interactionMode,
      initialMessageText,
      initialAttachments: draft.attachments,
    });
    flow.setSubmitting(false);

    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        Alert.alert(
          "Could not start task",
          error instanceof Error ? error.message : "The task could not be started.",
        );
      }
      return;
    }

    flow.setPrompt("");
    flow.clearAttachments();
    router.replace(buildThreadRoutePath(result.value));
  }

  if (!selectedProject) {
    return (
      <View className="flex-1 bg-sheet">
        <Stack.Screen options={{ title: "Loading task" }} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <Stack.Screen options={{ title: selectedProject.title }} />

      <KeyboardAvoidingView automaticOffset behavior="padding" style={{ flex: 1 }}>
        <View style={{ flex: 1, minHeight: 0, paddingHorizontal: 20, paddingTop: 8 }}>
          <ComposerEditor
            ref={promptInputRef}
            autoFocus
            multiline
            scrollEnabled
            value={flow.prompt}
            skills={flow.selectedProviderSkills}
            onChangeText={flow.setPrompt}
            onPasteImages={(uris) => void handleNativePasteImages(uris)}
            placeholder={`Describe a coding task in ${selectedProject.title}`}
            style={{ flex: 1, minHeight: 0 }}
            textStyle={MOBILE_TYPOGRAPHY.composer}
          />
        </View>

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
          <ComposerToolbarRow paddingBottom={controlsBottomPadding} paddingHorizontal={6}>
            <ComposerToolbarScroller
              fadeOpaque={sheetFadeOpaque}
              fadeTransparent={sheetFadeTransparent}
            >
              <ComposerToolbarButton
                icon="plus"
                onPress={() => void handlePickImages()}
                showChevron={false}
              />
              <ComposerToolbarTrigger
                accessibilityLabel="Model"
                iconNode={
                  <ProviderIcon provider={flow.selectedModelOption?.providerDriver} size={16} />
                }
                label={flow.selectedModelOption?.label ?? "Model"}
                onPress={() => setModelPickerVisible(true)}
              />
              <ComposerToolbarTrigger
                accessibilityLabel="Configuration"
                icon="slider.horizontal.3"
                label="Properties"
                onPress={() => setOptionsSheetVisible(true)}
              />
              <ControlPillMenu
                actions={environmentMenuActions}
                onPressAction={({ nativeEvent }) => handleEnvironmentMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Environment"
                  icon="desktopcomputer"
                  label={selectedEnvironmentLabel}
                />
              </ControlPillMenu>
              <ComposerToolbarTrigger
                accessibilityLabel="Workspace"
                icon="point.topleft.down.curvedto.point.bottomright.up"
                label={workspaceLabel}
                onPress={() => setWorkspaceSheetVisible(true)}
              />
            </ComposerToolbarScroller>
            <ComposerToolbarButton
              accessibilityLabel={flow.submitting ? "Starting task" : "Start task"}
              icon="arrow.up"
              onPress={() => void handleStart()}
              variant="primary"
              disabled={
                !flow.selectedProject ||
                !flow.selectedModel ||
                flow.prompt.trim().length === 0 ||
                flow.submitting ||
                (flow.workspaceMode === "worktree" && !flow.selectedBranchName)
              }
              showChevron={false}
            />
          </ComposerToolbarRow>
        </View>
      </KeyboardAvoidingView>
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
