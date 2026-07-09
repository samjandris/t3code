import { NativeStackScreenOptions } from "../../native/StackHeader";
import { StackActions, useNavigation } from "@react-navigation/native";
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

import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { convertPastedImagesToAttachments, pickComposerImages } from "../../lib/composerImages";
import { modelOptionKey } from "../../lib/modelOptions";
import {
  applyProviderOptionMenuEvent,
  buildProviderOptionMenuActions,
  providerOptionsConfigurationLabel,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { useProjects } from "../../state/entities";
import { enqueueThreadOutboxMessage, removeThreadOutboxMessage } from "../../state/thread-outbox";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
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
  /** Queued outbox message id when editing an existing pending task. */
  readonly pendingTaskId?: string;
}) {
  const projects = useProjects();
  const createProjectThread = useCreateProjectThread();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isKeyboardVisible = useKeyboardState((state) => state.isVisible);
  const controlsBottomPadding = isKeyboardVisible ? 8 : Math.max(insets.bottom, 10);
  const { logicalProjects, selectedProject, setProject } = flow;
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const environmentConnected =
    selectedProject !== null &&
    connectedEnvironments.find(
      (environment) => environment.environmentId === selectedProject.environmentId,
    )?.connectionState === "connected";
  const promptInputRef = useRef<ComposerEditorHandle>(null);
  const loadedBranchesProjectKeyRef = useRef<string | null>(null);
  const appliedInitialProjectKeyRef = useRef<string | null>(null);
  useEffect(() => {
    return () => {
      appliedInitialProjectKeyRef.current = null;
    };
  }, []);

  const { beginEditingPendingTask, cancelEditingPendingTask, editingPendingTask } = flow;
  const attemptedPendingTaskIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!props.pendingTaskId || editingPendingTask?.messageId === props.pendingTaskId) {
      return;
    }
    if (attemptedPendingTaskIdRef.current === props.pendingTaskId) {
      return;
    }
    attemptedPendingTaskIdRef.current = props.pendingTaskId;
    if (!beginEditingPendingTask(props.pendingTaskId)) {
      navigation.dispatch(StackActions.replace("NewTask"));
    }
  }, [beginEditingPendingTask, editingPendingTask?.messageId, navigation, props.pendingTaskId]);

  useEffect(() => {
    if (!props.pendingTaskId) return;
    return () => {
      attemptedPendingTaskIdRef.current = null;
      cancelEditingPendingTask();
    };
  }, [props.pendingTaskId, cancelEditingPendingTask]);
  const [modelPickerVisible, setModelPickerVisible] = useState(false);
  const [workspaceSheetVisible, setWorkspaceSheetVisible] = useState(false);
  const { favorites: modelFavorites, updateFavorites: updateModelFavorites } =
    useMobileModelFavorites();

  const borderColor = useThemeColor("--color-border");
  const headlineText = useScaledTextRole("headline");
  const sheetFadeOpaque = colorScheme === "dark" ? "rgba(14,14,14,0.98)" : "rgba(242,242,247,0.98)";
  const sheetFadeTransparent = colorScheme === "dark" ? "rgba(14,14,14,0)" : "rgba(242,242,247,0)";
  const lastInitialProjectRefRef = useRef(props.initialProjectRef);

  useEffect(() => {
    if (props.pendingTaskId) {
      return;
    }
    if (lastInitialProjectRefRef.current !== props.initialProjectRef) {
      lastInitialProjectRefRef.current = props.initialProjectRef;
      appliedInitialProjectKeyRef.current = null;
    }
    const initialEnvironmentId = props.initialProjectRef?.environmentId;
    const initialProjectId = props.initialProjectRef?.projectId;
    if (initialEnvironmentId && initialProjectId) {
      const directProject =
        projects.find(
          (project) =>
            project.environmentId === initialEnvironmentId && project.id === initialProjectId,
        ) ?? null;

      if (directProject) {
        const directProjectKey = `${directProject.environmentId}:${directProject.id}`;
        if (appliedInitialProjectKeyRef.current === directProjectKey) {
          return;
        }
        appliedInitialProjectKeyRef.current = directProjectKey;
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

    navigation.dispatch(StackActions.replace("NewTask"));
  }, [
    logicalProjects,
    projects,
    props.initialProjectRef,
    props.pendingTaskId,
    navigation,
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

  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: flow.selectedModelOption?.capabilities,
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption?.capabilities],
  );

  const optionsMenuActions = useMemo(
    () => [
      ...buildProviderOptionMenuActions(providerOptionDescriptors),
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
    [flow.interactionMode, flow.runtimeMode, providerOptionDescriptors],
  );
  const configurationLabel = useMemo(
    () => providerOptionsConfigurationLabel(providerOptionDescriptors),
    [providerOptionDescriptors],
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
    const providerOptions = applyProviderOptionMenuEvent(providerOptionDescriptors, event);
    if (providerOptions) {
      flow.setSelectedModelOptions(providerOptions);
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
    const draftKey = flow.draftKey;
    if (!selectedProject || !draftKey) {
      return;
    }
    const draft = getComposerDraftSnapshot(draftKey);
    const modelSelection = draft.modelSelection ?? flow.selectedModel;
    const workspaceMode = draft.workspaceSelection?.mode ?? flow.workspaceMode;
    const selectedBranchName = draft.workspaceSelection?.branch ?? flow.selectedBranchName;
    const selectedWorktreePath =
      draft.workspaceSelection?.worktreePath ?? flow.selectedWorktreePath;
    const startFromOrigin = draft.workspaceSelection?.startFromOrigin ?? flow.startFromOrigin;
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

    const editingPendingTask = flow.editingPendingTask;

    if (!environmentConnected) {
      const metadata = editingPendingTask
        ? {
            threadId: editingPendingTask.threadId,
            commandId: editingPendingTask.commandId,
            messageId: editingPendingTask.messageId,
            createdAt: editingPendingTask.createdAt,
          }
        : makeTurnCommandMetadata();
      const message = flow.buildPendingTaskMessage(metadata);
      if (!message) {
        return;
      }
      flow.setSubmitting(true);
      try {
        await enqueueThreadOutboxMessage(message);
      } catch (error) {
        Alert.alert(
          "Could not queue task",
          error instanceof Error ? error.message : "The task could not be saved to the outbox.",
        );
        return;
      } finally {
        flow.setSubmitting(false);
      }
      if (editingPendingTask) {
        flow.finishEditingPendingTask();
      } else {
        flow.setPrompt("");
        flow.clearAttachments();
      }
      navigation.getParent()?.goBack();
      return;
    }

    flow.setSubmitting(true);
    const result = await createProjectThread({
      project: selectedProject,
      modelSelection,
      envMode: workspaceMode,
      branch: selectedBranchName,
      worktreePath: workspaceMode === "worktree" ? null : selectedWorktreePath,
      startFromOrigin,
      runtimeMode,
      interactionMode,
      initialMessageText,
      initialAttachments: draft.attachments,
      ...(editingPendingTask
        ? {
            turnMetadata: {
              threadId: editingPendingTask.threadId,
              commandId: editingPendingTask.commandId,
              messageId: editingPendingTask.messageId,
              createdAt: editingPendingTask.createdAt,
            },
          }
        : {}),
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

    if (editingPendingTask) {
      try {
        await removeThreadOutboxMessage(editingPendingTask);
      } catch (error) {
        console.warn("[new-task] failed to remove delivered pending task", error);
      }
      flow.finishEditingPendingTask();
    } else {
      flow.setPrompt("");
      flow.clearAttachments();
    }
    navigation.dispatch(
      StackActions.replace("Thread", {
        environmentId: String(result.value.environmentId),
        threadId: String(result.value.threadId),
      }),
    );
  }

  if (!selectedProject) {
    return (
      <View className="flex-1 bg-sheet">
        <NativeStackScreenOptions options={{ title: "Loading task" }} />
      </View>
    );
  }

  return (
    <View className="flex-1 bg-sheet">
      <NativeStackScreenOptions options={{ title: selectedProject.title }} />

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
            textStyle={headlineText}
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
              <ControlPillMenu
                actions={optionsMenuActions}
                onPressAction={({ nativeEvent }) => handleOptionsMenuAction(nativeEvent.event)}
              >
                <ComposerToolbarTrigger
                  accessibilityLabel="Configuration"
                  icon="slider.horizontal.3"
                  label={configurationLabel}
                />
              </ControlPillMenu>
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
              accessibilityLabel={
                flow.submitting
                  ? "Starting task"
                  : environmentConnected
                    ? "Start task"
                    : "Queue task"
              }
              icon={environmentConnected ? "arrow.up" : "tray.and.arrow.up"}
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
      <MobileWorkspaceSheet
        visible={workspaceSheetVisible}
        workspaceMode={flow.workspaceMode}
        startFromOrigin={flow.startFromOrigin}
        selectedBranchName={flow.selectedBranchName}
        branchQuery={flow.branchQuery}
        branchesLoading={flow.branchesLoading}
        branches={flow.filteredBranches}
        selectedProject={flow.selectedProject}
        onClose={() => setWorkspaceSheetVisible(false)}
        onSelectWorkspaceMode={flow.setWorkspaceMode}
        onStartFromOriginChange={flow.setStartFromOrigin}
        onChangeBranchQuery={flow.setBranchQuery}
        onSelectBranch={flow.selectBranch}
      />
    </View>
  );
}
