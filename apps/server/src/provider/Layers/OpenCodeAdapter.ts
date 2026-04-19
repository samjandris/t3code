import { randomUUID } from "node:crypto";

import {
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { Cause, Effect, Layer, Queue, Stream } from "effect";
import type { OpencodeClient, Part, PermissionRequest, QuestionRequest } from "@opencode-ai/sdk/v2";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodePermissionRules,
  connectToOpenCodeServer,
  createOpenCodeSdkClient,
  openCodeQuestionId,
  parseOpenCodeModelSlug,
  toOpenCodeFileParts,
  toOpenCodePermissionReply,
  toOpenCodeQuestionAnswers,
  type OpenCodeServerConnection,
} from "../opencodeRuntime.ts";

const PROVIDER = "opencode" as const;
const OPENCODE_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a \`<proposed_plan>\` block.

Separately, \`update_plan\` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use \`update_plan\` while in Plan mode. If you try to use \`update_plan\` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, \`target/\`, \`.cache/\`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the \`question\` tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the \`question\` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2-4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.
</collaboration_mode>`;
const OPENCODE_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## question availability

The \`question\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`;
const PROPOSED_PLAN_BLOCK_REGEX = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i;
const PROPOSED_PLAN_OPEN_TAG = "<proposed_plan>";
const PROPOSED_PLAN_CLOSE_TAG = "</proposed_plan>";

interface OpenCodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCodeSessionContext {
  session: ProviderSession;
  readonly client: OpencodeClient;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  readonly openCodeSessionId: string;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingQuestions: Map<string, QuestionRequest>;
  readonly messageRoleById: Map<string, "user" | "assistant">;
  readonly partById: Map<string, Part>;
  readonly emittedTextByPartId: Map<string, string>;
  readonly emittedProposedPlanLengthByPartId: Map<string, number>;
  readonly completedAssistantPartIds: Set<string>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly turns: Array<OpenCodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  activeVariant: string | undefined;
  stopped: boolean;
  readonly eventsAbortController: AbortController;
}

export interface OpenCodeAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isProviderAdapterRequestError(cause: unknown): cause is ProviderAdapterRequestError {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ProviderAdapterRequestError"
  );
}

function buildEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: input.createdAt ?? nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "opencode.sdk.event",
            payload: input.raw,
          },
        }
      : {}),
  };
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command")) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subtask")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  permission: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (permission) {
    case "bash":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

function resolveTurnSnapshot(
  context: OpenCodeSessionContext,
  turnId: TurnId,
): OpenCodeTurnSnapshot {
  const existing = context.turns.find((turn) => turn.id === turnId);
  if (existing) {
    return existing;
  }

  const created: OpenCodeTurnSnapshot = { id: turnId, items: [] };
  context.turns.push(created);
  return created;
}

function appendTurnItem(
  context: OpenCodeSessionContext,
  turnId: TurnId | undefined,
  item: unknown,
): void {
  if (!turnId) {
    return;
  }
  resolveTurnSnapshot(context, turnId).items.push(item);
}

function ensureSessionContext(
  sessions: ReadonlyMap<ThreadId, OpenCodeSessionContext>,
  threadId: ThreadId,
): OpenCodeSessionContext {
  const session = sessions.get(threadId);
  if (!session) {
    throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
  }
  if (session.stopped) {
    throw new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
  }
  return session;
}

function normalizeQuestionRequest(request: QuestionRequest): ReadonlyArray<UserInputQuestion> {
  return request.questions.map((question, index) => ({
    id: openCodeQuestionId(index, question),
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    ...(question.multiple ? { multiSelect: true } : {}),
  }));
}

function resolveTextStreamKind(part: Part | undefined): "assistant_text" | "reasoning_text" {
  return part?.type === "reasoning" ? "reasoning_text" : "assistant_text";
}

function textFromPart(part: Part): string | undefined {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text;
    default:
      return undefined;
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return index;
}

function suffixPrefixOverlap(text: string, delta: string): number {
  const maxLength = Math.min(text.length, delta.length);
  for (let length = maxLength; length > 0; length -= 1) {
    if (text.endsWith(delta.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function resolveLatestAssistantText(previousText: string | undefined, nextText: string): string {
  if (previousText && previousText.length > nextText.length && previousText.startsWith(nextText)) {
    return previousText;
  }
  return nextText;
}

export function mergeOpenCodeAssistantText(
  previousText: string | undefined,
  nextText: string,
): {
  readonly latestText: string;
  readonly deltaToEmit: string;
} {
  const latestText = resolveLatestAssistantText(previousText, nextText);
  return {
    latestText,
    deltaToEmit: latestText.slice(commonPrefixLength(previousText ?? "", latestText)),
  };
}

export function appendOpenCodeAssistantTextDelta(
  previousText: string,
  delta: string,
): {
  readonly nextText: string;
  readonly deltaToEmit: string;
} {
  const deltaToEmit = delta.slice(suffixPrefixOverlap(previousText, delta));
  return {
    nextText: previousText + deltaToEmit,
    deltaToEmit,
  };
}

function isoFromEpochMs(value: number | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return new Date(value).toISOString();
}

function messageRoleForPart(
  context: OpenCodeSessionContext,
  part: Pick<Part, "messageID" | "type">,
): "assistant" | "user" | undefined {
  const known = context.messageRoleById.get(part.messageID);
  if (known) {
    return known;
  }
  return part.type === "tool" ? "assistant" : undefined;
}

function detailFromToolPart(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "completed":
      return part.state.output;
    case "error":
      return part.state.error;
    case "running":
      return part.state.title;
    default:
      return undefined;
  }
}

function toolStateCreatedAt(part: Extract<Part, { type: "tool" }>): string | undefined {
  switch (part.state.status) {
    case "running":
      return isoFromEpochMs(part.state.time.start);
    case "completed":
    case "error":
      return isoFromEpochMs(part.state.time.end);
    default:
      return undefined;
  }
}

function sessionErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "OpenCode session failed.";
  }
  const data = "data" in error && error.data && typeof error.data === "object" ? error.data : null;
  const message = data && "message" in data ? data.message : null;
  return typeof message === "string" && message.trim().length > 0
    ? message
    : "OpenCode session failed.";
}

function updateProviderSession(
  context: OpenCodeSessionContext,
  patch: Partial<ProviderSession>,
  options?: {
    readonly clearActiveTurnId?: boolean;
    readonly clearLastError?: boolean;
  },
): ProviderSession {
  const nextSession = {
    ...context.session,
    ...patch,
    updatedAt: nowIso(),
  } as ProviderSession & Record<string, unknown>;
  const mutableSession = nextSession as Record<string, unknown>;
  if (options?.clearActiveTurnId) {
    delete mutableSession.activeTurnId;
  }
  if (options?.clearLastError) {
    delete mutableSession.lastError;
  }
  context.session = nextSession;
  return nextSession;
}

async function stopOpenCodeContext(context: OpenCodeSessionContext): Promise<void> {
  context.stopped = true;
  context.eventsAbortController.abort();
  try {
    await context.client.session
      .abort({ sessionID: context.openCodeSessionId })
      .catch(() => undefined);
  } catch {}
  context.server.close();
}

function resolveSystemInstructions(interactionMode: "default" | "plan"): string {
  return interactionMode === "plan"
    ? OPENCODE_PLAN_MODE_DEVELOPER_INSTRUCTIONS
    : OPENCODE_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS;
}

function projectStreamingProposedPlanContent(text: string | undefined): {
  visibleText: string | undefined;
  planText: string | undefined;
} {
  if (!text) {
    return {
      visibleText: undefined,
      planText: undefined,
    };
  }

  let visibleText = "";
  let planText = "";
  let outsidePlan = true;
  let openTagBuffer = "";
  let closeTagBuffer = "";

  for (let index = 0; index < text.length; ) {
    const char = text[index]!;
    const normalizedChar = char.toLowerCase();

    if (outsidePlan) {
      const expectedChar = PROPOSED_PLAN_OPEN_TAG[openTagBuffer.length];
      if (expectedChar && normalizedChar === expectedChar) {
        openTagBuffer += char;
        index += 1;
        if (openTagBuffer.length === PROPOSED_PLAN_OPEN_TAG.length) {
          openTagBuffer = "";
          outsidePlan = false;
        }
        continue;
      }

      if (openTagBuffer.length > 0) {
        visibleText += openTagBuffer;
        openTagBuffer = "";
        continue;
      }

      visibleText += char;
      index += 1;
      continue;
    }

    const expectedChar = PROPOSED_PLAN_CLOSE_TAG[closeTagBuffer.length];
    if (expectedChar && normalizedChar === expectedChar) {
      closeTagBuffer += char;
      index += 1;
      if (closeTagBuffer.length === PROPOSED_PLAN_CLOSE_TAG.length) {
        closeTagBuffer = "";
        outsidePlan = true;
      }
      continue;
    }

    if (closeTagBuffer.length > 0) {
      planText += closeTagBuffer;
      closeTagBuffer = "";
      continue;
    }

    planText += char;
    index += 1;
  }

  return {
    visibleText,
    planText: planText.length > 0 ? planText : undefined,
  };
}

function extractProposedPlanMarkdown(text: string | undefined): string | undefined {
  const match = text ? PROPOSED_PLAN_BLOCK_REGEX.exec(text) : null;
  const planMarkdown = match?.[1]?.trim();
  return planMarkdown && planMarkdown.length > 0 ? planMarkdown : undefined;
}

function extractStreamingProposedPlanText(text: string | undefined): string | undefined {
  return projectStreamingProposedPlanContent(text).planText;
}

function stripProposedPlanBlockFromVisibleText(text: string | undefined): string | undefined {
  return projectStreamingProposedPlanContent(text).visibleText;
}

function appendDeltaToTextPart(
  part: Extract<Part, { type: "text" | "reasoning" }>,
  delta: string,
): Extract<Part, { type: "text" | "reasoning" }> {
  return {
    ...part,
    text: `${part.text}${delta}`,
  };
}

function proposedPlanCaptureKey(input: { readonly partId: string; readonly planMarkdown: string }) {
  return `part:${input.partId}:plan:${input.planMarkdown}`;
}

export function makeOpenCodeAdapterLive(_options?: OpenCodeAdapterLiveOptions) {
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const services = yield* Effect.context<never>();
      const nativeEventLogger =
        _options?.nativeEventLogger ??
        (_options?.nativeEventLogPath !== undefined
          ? yield* makeEventNdjsonLogger(_options.nativeEventLogPath, {
              stream: "native",
            })
          : undefined);
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, OpenCodeSessionContext>();

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
      const emitPromise = (event: ProviderRuntimeEvent) =>
        emit(event).pipe(Effect.runPromiseWith(services));
      const writeNativeEventPromise = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) =>
        (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void).pipe(
          Effect.runPromiseWith(services),
        );
      const writeNativeEventBestEffort = (
        threadId: ThreadId,
        event: {
          readonly observedAt: string;
          readonly event: Record<string, unknown>;
        },
      ) => writeNativeEventPromise(threadId, event).catch(() => undefined);

      const emitUnexpectedExit = (context: OpenCodeSessionContext, message: string) => {
        if (context.stopped) {
          return;
        }
        context.stopped = true;
        sessions.delete(context.session.threadId);
        context.server.close();
        const turnId = context.activeTurnId;
        void emitPromise({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "runtime.error",
          payload: {
            message,
            class: "transport_error",
          },
        }).catch(() => undefined);
        void emitPromise({
          ...buildEventBase({ threadId: context.session.threadId, turnId }),
          type: "session.exited",
          payload: {
            reason: message,
            recoverable: false,
            exitKind: "error",
          },
        }).catch(() => undefined);
      };

      const emitAssistantTextDelta = async (
        context: OpenCodeSessionContext,
        part: Part,
        turnId: TurnId | undefined,
        raw: unknown,
      ): Promise<void> => {
        const rawText = textFromPart(part);
        if (rawText === undefined) {
          return;
        }

        const text =
          part.type === "text" ? (stripProposedPlanBlockFromVisibleText(rawText) ?? "") : rawText;
        const previousText = context.emittedTextByPartId.get(part.id);
        const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(previousText, text);
        context.emittedTextByPartId.set(part.id, latestText);
        if (deltaToEmit.length > 0) {
          await emitPromise({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt:
                part.type === "text" || part.type === "reasoning"
                  ? isoFromEpochMs(part.time?.start)
                  : undefined,
              raw,
            }),
            type: "content.delta",
            payload: {
              streamKind: resolveTextStreamKind(part),
              delta: deltaToEmit,
            },
          });
        }

        if (part.type === "text") {
          const planText = extractStreamingProposedPlanText(rawText);
          if (planText) {
            const previousLength = context.emittedProposedPlanLengthByPartId.get(part.id) ?? 0;
            if (planText.length > previousLength) {
              context.emittedProposedPlanLengthByPartId.set(part.id, planText.length);
              await emitPromise({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: part.id,
                  createdAt: isoFromEpochMs(part.time?.start),
                  raw,
                }),
                type: "turn.proposed.delta",
                payload: {
                  delta: planText.slice(previousLength),
                },
              });
            }
          }
        }

        if (
          part.type === "text" &&
          part.time?.end !== undefined &&
          !context.completedAssistantPartIds.has(part.id)
        ) {
          const planMarkdown = extractProposedPlanMarkdown(rawText);
          if (planMarkdown) {
            const captureKey = proposedPlanCaptureKey({ partId: part.id, planMarkdown });
            if (!context.capturedProposedPlanKeys.has(captureKey)) {
              context.capturedProposedPlanKeys.add(captureKey);
              await emitPromise({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: part.id,
                  createdAt: isoFromEpochMs(part.time.end),
                  raw,
                }),
                type: "turn.proposed.completed",
                payload: { planMarkdown },
              });
            }
          }

          context.completedAssistantPartIds.add(part.id);
          await emitPromise({
            ...buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.id,
              createdAt: isoFromEpochMs(part.time.end),
              raw,
            }),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(latestText.length > 0 ? { detail: latestText } : {}),
            },
          });
        }
      };

      const startEventPump = (context: OpenCodeSessionContext) => {
        void (async () => {
          try {
            const subscription = await context.client.event.subscribe(undefined, {
              signal: context.eventsAbortController.signal,
            });

            for await (const event of subscription.stream) {
              const payloadSessionId =
                "properties" in event
                  ? (event.properties as { sessionID?: unknown }).sessionID
                  : undefined;
              if (payloadSessionId !== context.openCodeSessionId) {
                continue;
              }

              const turnId = context.activeTurnId;
              await writeNativeEventBestEffort(context.session.threadId, {
                observedAt: nowIso(),
                event: {
                  provider: PROVIDER,
                  threadId: context.session.threadId,
                  providerThreadId: context.openCodeSessionId,
                  type: event.type,
                  ...(turnId ? { turnId } : {}),
                  payload: event,
                },
              });

              switch (event.type) {
                case "message.updated": {
                  context.messageRoleById.set(event.properties.info.id, event.properties.info.role);
                  if (event.properties.info.role === "assistant") {
                    for (const part of context.partById.values()) {
                      if (part.messageID !== event.properties.info.id) {
                        continue;
                      }
                      await emitAssistantTextDelta(context, part, turnId, event);
                    }
                  }
                  break;
                }

                case "message.removed": {
                  context.messageRoleById.delete(event.properties.messageID);
                  break;
                }

                case "message.part.delta": {
                  const existingPart = context.partById.get(event.properties.partID);
                  if (!existingPart) {
                    break;
                  }
                  const role = messageRoleForPart(context, existingPart);
                  if (role !== "assistant") {
                    break;
                  }
                  const delta = event.properties.delta;
                  if (delta.length === 0) {
                    break;
                  }
                  if (existingPart.type === "text" || existingPart.type === "reasoning") {
                    const nextPart = appendDeltaToTextPart(existingPart, delta);
                    context.partById.set(event.properties.partID, nextPart);
                    await emitAssistantTextDelta(context, nextPart, turnId, event);
                  }
                  break;
                }

                case "message.part.updated": {
                  const part = event.properties.part;
                  context.partById.set(part.id, part);
                  const messageRole = messageRoleForPart(context, part);

                  if (messageRole === "assistant") {
                    await emitAssistantTextDelta(context, part, turnId, event);
                  }

                  if (part.type === "tool") {
                    const itemType = toToolLifecycleItemType(part.tool);
                    const title =
                      part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;
                    const detail = detailFromToolPart(part);
                    const payload = {
                      itemType,
                      ...(part.state.status === "error"
                        ? { status: "failed" as const }
                        : part.state.status === "completed"
                          ? { status: "completed" as const }
                          : { status: "inProgress" as const }),
                      ...(title ? { title } : {}),
                      ...(detail ? { detail } : {}),
                      data: {
                        tool: part.tool,
                        state: part.state,
                      },
                    };
                    const runtimeEvent: ProviderRuntimeEvent = {
                      ...buildEventBase({
                        threadId: context.session.threadId,
                        turnId,
                        itemId: part.callID,
                        createdAt: toolStateCreatedAt(part),
                        raw: event,
                      }),
                      type:
                        part.state.status === "pending"
                          ? "item.started"
                          : part.state.status === "completed" || part.state.status === "error"
                            ? "item.completed"
                            : "item.updated",
                      payload,
                    };
                    appendTurnItem(context, turnId, part);
                    await emitPromise(runtimeEvent);
                  }
                  break;
                }

                case "permission.asked": {
                  context.pendingPermissions.set(event.properties.id, event.properties);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.id,
                      raw: event,
                    }),
                    type: "request.opened",
                    payload: {
                      requestType: mapPermissionToRequestType(event.properties.permission),
                      detail:
                        event.properties.patterns.length > 0
                          ? event.properties.patterns.join("\n")
                          : event.properties.permission,
                      args: event.properties.metadata,
                    },
                  });
                  break;
                }

                case "permission.replied": {
                  context.pendingPermissions.delete(event.properties.requestID);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.requestID,
                      raw: event,
                    }),
                    type: "request.resolved",
                    payload: {
                      requestType: "unknown",
                      decision: mapPermissionDecision(event.properties.reply),
                    },
                  });
                  break;
                }

                case "question.asked": {
                  context.pendingQuestions.set(event.properties.id, event.properties);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.id,
                      raw: event,
                    }),
                    type: "user-input.requested",
                    payload: {
                      questions: normalizeQuestionRequest(event.properties),
                    },
                  });
                  break;
                }

                case "question.replied": {
                  const request = context.pendingQuestions.get(event.properties.requestID);
                  context.pendingQuestions.delete(event.properties.requestID);
                  const answers = Object.fromEntries(
                    (request?.questions ?? []).map((question, index) => [
                      openCodeQuestionId(index, question),
                      event.properties.answers[index]?.join(", ") ?? "",
                    ]),
                  );
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.requestID,
                      raw: event,
                    }),
                    type: "user-input.resolved",
                    payload: { answers },
                  });
                  break;
                }

                case "question.rejected": {
                  context.pendingQuestions.delete(event.properties.requestID);
                  await emitPromise({
                    ...buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.requestID,
                      raw: event,
                    }),
                    type: "user-input.resolved",
                    payload: { answers: {} },
                  });
                  break;
                }

                case "session.status": {
                  if (event.properties.status.type === "busy") {
                    updateProviderSession(context, { status: "running", activeTurnId: turnId });
                  }

                  if (event.properties.status.type === "retry") {
                    await emitPromise({
                      ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                      type: "runtime.warning",
                      payload: {
                        message: event.properties.status.message,
                        detail: event.properties.status,
                      },
                    });
                    break;
                  }

                  if (event.properties.status.type === "idle" && turnId) {
                    context.activeTurnId = undefined;
                    updateProviderSession(
                      context,
                      { status: "ready" },
                      { clearActiveTurnId: true },
                    );
                    await emitPromise({
                      ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                      type: "turn.completed",
                      payload: {
                        state: "completed",
                      },
                    });
                  }
                  break;
                }

                case "session.error": {
                  const message = sessionErrorMessage(event.properties.error);
                  const activeTurnId = context.activeTurnId;
                  context.activeTurnId = undefined;
                  updateProviderSession(
                    context,
                    {
                      status: "error",
                      lastError: message,
                    },
                    { clearActiveTurnId: true },
                  );
                  if (activeTurnId) {
                    await emitPromise({
                      ...buildEventBase({
                        threadId: context.session.threadId,
                        turnId: activeTurnId,
                        raw: event,
                      }),
                      type: "turn.completed",
                      payload: {
                        state: "failed",
                        errorMessage: message,
                      },
                    });
                  }
                  await emitPromise({
                    ...buildEventBase({ threadId: context.session.threadId, raw: event }),
                    type: "runtime.error",
                    payload: {
                      message,
                      class: "provider_error",
                      detail: event.properties.error,
                    },
                  });
                  break;
                }

                default:
                  break;
              }
            }
          } catch (error) {
            if (context.eventsAbortController.signal.aborted || context.stopped) {
              return;
            }
            emitUnexpectedExit(
              context,
              error instanceof Error ? error.message : "OpenCode event stream failed.",
            );
          }
        })();

        context.server.process?.once("exit", (code, signal) => {
          if (context.stopped) {
            return;
          }
          emitUnexpectedExit(
            context,
            `OpenCode server exited unexpectedly (${signal ?? code ?? "unknown"}).`,
          );
        });
      };

      const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
        function* (input) {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to read OpenCode settings.",
                  cause,
                }),
            ),
          );
          const binaryPath = settings.providers.opencode.binaryPath;
          const serverUrl = settings.providers.opencode.serverUrl;
          const serverPassword = settings.providers.opencode.serverPassword;
          const directory = input.cwd ?? serverConfig.cwd;
          const existing = sessions.get(input.threadId);
          if (existing) {
            yield* Effect.tryPromise({
              try: () => stopOpenCodeContext(existing),
              catch: (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to stop existing OpenCode session.",
                  cause,
                }),
            });
            sessions.delete(input.threadId);
          }

          const started = yield* Effect.tryPromise({
            try: async () => {
              const server = await connectToOpenCodeServer({ binaryPath, serverUrl });
              const client = createOpenCodeSdkClient({
                baseUrl: server.url,
                directory,
                ...(server.external && serverPassword ? { serverPassword } : {}),
              });
              const openCodeSessionId = (
                await client.session.create({
                  title: `T3 Code ${input.threadId}`,
                  permission: buildOpenCodePermissionRules(input.runtimeMode),
                })
              ).data?.id;
              if (!openCodeSessionId) {
                throw new Error("OpenCode session.create returned no session payload.");
              }
              return { server, client, openCodeSessionId };
            },
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail:
                  cause instanceof Error ? cause.message : "Failed to start OpenCode session.",
                cause,
              }),
          });

          // Guard against a concurrent startSession call that may have raced
          // and already inserted a session while we were awaiting async work.
          const raceWinner = sessions.get(input.threadId);
          if (raceWinner) {
            // Another call won the race – clean up the session we just created
            // (including the remote SDK session) and return the existing one.
            yield* Effect.tryPromise({
              try: () =>
                started.client.session
                  .abort({ sessionID: started.openCodeSessionId })
                  .catch(() => undefined),
              catch: () => undefined,
            }).pipe(Effect.ignore);
            started.server.close();
            return raceWinner.session;
          }

          const createdAt = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd: directory,
            ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
            threadId: input.threadId,
            createdAt,
            updatedAt: createdAt,
          };

          const context: OpenCodeSessionContext = {
            session,
            client: started.client,
            server: started.server,
            directory,
            openCodeSessionId: started.openCodeSessionId,
            pendingPermissions: new Map(),
            pendingQuestions: new Map(),
            partById: new Map(),
            emittedTextByPartId: new Map(),
            emittedProposedPlanLengthByPartId: new Map(),
            messageRoleById: new Map(),
            completedAssistantPartIds: new Set(),
            capturedProposedPlanKeys: new Set(),
            turns: [],
            activeTurnId: undefined,
            activeVariant: undefined,
            stopped: false,
            eventsAbortController: new AbortController(),
          };
          sessions.set(input.threadId, context);
          startEventPump(context);

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: {
              message: "OpenCode session started",
            },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {
              providerThreadId: started.openCodeSessionId,
            },
          });

          return session;
        },
      );

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
        const context = ensureSessionContext(sessions, input.threadId);
        const turnId = TurnId.make(`opencode-turn-${randomUUID()}`);
        const modelSelection =
          input.modelSelection ??
          (context.session.model
            ? { provider: PROVIDER, model: context.session.model }
            : undefined);
        const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
        if (!parsedModel) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode model selection must use the 'provider/model' format.",
          });
        }

        const text = input.input?.trim();
        const fileParts = toOpenCodeFileParts({
          attachments: input.attachments,
          resolveAttachmentPath: (attachment) =>
            resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
        });
        if ((!text || text.length === 0) && fileParts.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "OpenCode turns require text input or at least one attachment.",
          });
        }

        const variant =
          input.modelSelection?.provider === PROVIDER
            ? input.modelSelection.options?.variant
            : undefined;
        const interactionMode = input.interactionMode ?? "default";
        const system = resolveSystemInstructions(interactionMode);

        context.emittedProposedPlanLengthByPartId.clear();
        context.capturedProposedPlanKeys.clear();
        context.activeTurnId = turnId;
        context.activeVariant = variant;
        updateProviderSession(
          context,
          {
            status: "running",
            activeTurnId: turnId,
            model: modelSelection?.model ?? context.session.model,
          },
          { clearLastError: true },
        );

        yield* emit({
          ...buildEventBase({ threadId: input.threadId, turnId }),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });

        const promptExit = yield* Effect.exit(
          Effect.tryPromise({
            try: async () => {
              await context.client.session.promptAsync({
                sessionID: context.openCodeSessionId,
                model: parsedModel,
                ...(context.activeVariant ? { variant: context.activeVariant } : {}),
                system,
                parts: [...(text ? [{ type: "text" as const, text }] : []), ...fileParts],
              });
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.promptAsync",
                detail: cause instanceof Error ? cause.message : "Failed to send OpenCode turn.",
                cause,
              }),
          }),
        );
        if (promptExit._tag === "Failure") {
          const failure = Cause.squash(promptExit.cause);
          const requestError = isProviderAdapterRequestError(failure)
            ? failure
            : new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.promptAsync",
                detail:
                  failure instanceof Error ? failure.message : "Failed to send OpenCode turn.",
                cause: failure,
              });
          const failureMessage = requestError.detail;
          context.activeTurnId = undefined;
          context.activeVariant = undefined;
          updateProviderSession(
            context,
            {
              status: "ready",
              model: modelSelection?.model ?? context.session.model,
              lastError: failureMessage,
            },
            { clearActiveTurnId: true },
          );
          yield* emit({
            ...buildEventBase({ threadId: input.threadId, turnId }),
            type: "turn.aborted",
            payload: {
              reason: failureMessage,
            },
          });
          return yield* requestError;
        }

        return {
          threadId: input.threadId,
          turnId,
        };
      });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
        function* (threadId, turnId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* Effect.tryPromise({
            try: () => context.client.session.abort({ sessionID: context.openCodeSessionId }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.abort",
                detail: cause instanceof Error ? cause.message : "Failed to abort OpenCode turn.",
                cause,
              }),
          });
          if (turnId ?? context.activeTurnId) {
            yield* emit({
              ...buildEventBase({ threadId, turnId: turnId ?? context.activeTurnId }),
              type: "turn.aborted",
              payload: {
                reason: "Interrupted by user.",
              },
            });
          }
        },
      );

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
        "respondToRequest",
      )(function* (threadId, requestId, decision) {
        const context = ensureSessionContext(sessions, threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission.reply",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }

        yield* Effect.tryPromise({
          try: () =>
            context.client.permission.reply({
              requestID: requestId,
              reply: toOpenCodePermissionReply(decision),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission.reply",
              detail:
                cause instanceof Error
                  ? cause.message
                  : "Failed to submit OpenCode permission reply.",
              cause,
            }),
        });
      });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
        "respondToUserInput",
      )(function* (threadId, requestId, answers) {
        const context = ensureSessionContext(sessions, threadId);
        const request = context.pendingQuestions.get(requestId);
        if (!request) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "question.reply",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* Effect.tryPromise({
          try: () =>
            context.client.question.reply({
              requestID: requestId,
              answers: toOpenCodeQuestionAnswers(request, answers),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "question.reply",
              detail: cause instanceof Error ? cause.message : "Failed to submit OpenCode answers.",
              cause,
            }),
        });
      });

      const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          yield* Effect.tryPromise({
            try: () => stopOpenCodeContext(context),
            catch: (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId,
                detail: cause instanceof Error ? cause.message : "Failed to stop OpenCode session.",
                cause,
              }),
          });
          sessions.delete(threadId);
          yield* emit({
            ...buildEventBase({ threadId }),
            type: "session.exited",
            payload: {
              reason: "Session stopped.",
              recoverable: false,
              exitKind: "graceful",
            },
          });
        },
      );

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session));

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => sessions.has(threadId));

      const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
        function* (threadId) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* Effect.tryPromise({
            try: () => context.client.session.messages({ sessionID: context.openCodeSessionId }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.messages",
                detail: cause instanceof Error ? cause.message : "Failed to read OpenCode thread.",
                cause,
              }),
          });

          const turns = (messages.data ?? [])
            .filter((entry) => entry.info.role === "assistant")
            .map((entry) => ({
              id: TurnId.make(entry.info.id),
              items: [entry.info, ...entry.parts],
            }));

          return {
            threadId,
            turns,
          };
        },
      );

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
        function* (threadId, numTurns) {
          const context = ensureSessionContext(sessions, threadId);
          const messages = yield* Effect.tryPromise({
            try: () => context.client.session.messages({ sessionID: context.openCodeSessionId }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.messages",
                detail:
                  cause instanceof Error ? cause.message : "Failed to inspect OpenCode thread.",
                cause,
              }),
          });

          const assistantMessages = (messages.data ?? []).filter(
            (entry) => entry.info.role === "assistant",
          );
          const targetIndex = assistantMessages.length - numTurns - 1;
          const target = targetIndex >= 0 ? assistantMessages[targetIndex] : null;
          yield* Effect.tryPromise({
            try: () =>
              context.client.session.revert({
                sessionID: context.openCodeSessionId,
                ...(target ? { messageID: target.info.id } : {}),
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session.revert",
                detail: cause instanceof Error ? cause.message : "Failed to revert OpenCode turn.",
                cause,
              }),
          });

          return yield* readThread(threadId);
        },
      );

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.tryPromise({
          try: async () => {
            const contexts = [...sessions.values()];
            sessions.clear();
            const results = await Promise.allSettled(
              contexts.map((context) => stopOpenCodeContext(context)),
            );
            const errors = results
              .filter((result): result is PromiseRejectedResult => result.status === "rejected")
              .map((result) => result.reason);
            if (errors.length === 1) {
              throw errors[0];
            }
            if (errors.length > 1) {
              throw new AggregateError(
                errors,
                `Failed to stop ${errors.length} OpenCode sessions.`,
              );
            }
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: "*",
              detail: cause instanceof Error ? cause.message : "Failed to stop OpenCode sessions.",
              cause,
            }),
        });

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        get streamEvents() {
          return Stream.fromQueue(runtimeEvents);
        },
      } satisfies OpenCodeAdapterShape;
    }),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();
