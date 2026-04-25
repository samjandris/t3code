import { randomUUID } from "node:crypto";

import {
  ApprovalRequestId,
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, PubSub, Scope, Stream } from "effect";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  appendAndCaptureProposedPlan,
  createPlanModeCaptureState,
  wrapPiPlanModePrompt,
  type PlanModeCaptureState,
} from "../PlanModeCapture.ts";
import {
  makePiRpcRuntime,
  type PiRpcEvent,
  type PiRpcRuntimeError,
  type PiRpcRuntimeShape,
} from "../pi/PiRpcRuntime.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "pi" as const;
const PI_RESUME_VERSION = 1;

export interface PiAdapterLiveOptions {
  readonly makeRuntime?: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly configDir?: string;
  }) => Effect.Effect<PiRpcRuntimeShape, PiRpcRuntimeError, Scope.Scope>;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingUserInput {
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  readonly requestId: string;
}

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: PiRpcRuntimeShape;
  readonly turns: Array<PiTurnSnapshot>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  eventFiber: Fiber.Fiber<void, never> | undefined;
  activeTurnId: TurnId | undefined;
  activePlanCapture: PlanModeCaptureState | undefined;
  stopped: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function makeEventBase(input: {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly raw?: unknown;
}): Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "threadId" | "createdAt" | "turnId" | "itemId" | "requestId" | "raw"
> {
  return {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: input.threadId,
    createdAt: nowIso(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw !== undefined
      ? {
          raw: {
            source: "pi.rpc.event",
            payload: input.raw,
          },
        }
      : {}),
  };
}

function mapPiError(
  threadId: ThreadId,
  method: string,
  cause: PiRpcRuntimeError,
): ProviderAdapterError {
  if (
    cause.detail.toLowerCase().includes("stopped") ||
    cause.detail.toLowerCase().includes("exited")
  ) {
    return new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId, cause });
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause.message,
    cause,
  });
}

function parsePiModelSlug(model: string | undefined): { provider?: string; modelId?: string } {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return {};
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return { modelId: trimmed };
  }
  return {
    provider: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  };
}

function parsePiResumeCursor(value: unknown): {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
} {
  if (!isRecord(value) || value.schemaVersion !== PI_RESUME_VERSION) return {};
  return {
    ...(typeof value.sessionFile === "string" ? { sessionFile: value.sessionFile } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.sessionName === "string" ? { sessionName: value.sessionName } : {}),
  };
}

function piResumeCursorFromState(state: unknown): ProviderSession["resumeCursor"] {
  const record = isRecord(state) ? state : {};
  return {
    schemaVersion: PI_RESUME_VERSION,
    ...(stringField(record, ["sessionFile", "session_file", "path"])
      ? {
          sessionFile: stringField(record, ["sessionFile", "session_file", "path"]),
        }
      : {}),
    ...(stringField(record, ["sessionId", "session_id", "id"])
      ? {
          sessionId: stringField(record, ["sessionId", "session_id", "id"]),
        }
      : {}),
    ...(stringField(record, ["sessionName", "session_name", "name"])
      ? {
          sessionName: stringField(record, ["sessionName", "session_name", "name"]),
        }
      : {}),
  };
}

function eventName(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return stringField(payload, ["event", "type", "name", "kind"]);
}

function textDeltaFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const direct = stringField(payload, ["delta", "textDelta", "text", "content"]);
  if (direct) return direct;
  const message = payload.message;
  return isRecord(message)
    ? stringField(message, ["delta", "textDelta", "text", "content"])
    : undefined;
}

function toolIdFromPayload(payload: unknown): string {
  if (!isRecord(payload)) return randomUUID();
  return stringField(payload, ["toolCallId", "tool_call_id", "id", "itemId"]) ?? randomUUID();
}

function toolTitleFromPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return stringField(payload, ["title", "name", "tool", "command"]);
}

function extensionUiRequestId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  return stringField(payload, ["requestId", "request_id", "id"]);
}

function extensionUiRequestKind(payload: unknown): string {
  if (!isRecord(payload)) return "input";
  return (
    stringField(payload, ["requestType", "request_type", "uiType", "ui_type", "type", "kind"]) ??
    "input"
  );
}

function extensionUiPrompt(payload: unknown): string {
  if (!isRecord(payload)) return "Pi requested input.";
  return stringField(payload, ["prompt", "message", "title", "label"]) ?? "Pi requested input.";
}

function extensionUiOptions(
  payload: unknown,
): ReadonlyArray<{ label: string; description: string }> {
  if (!isRecord(payload) || !Array.isArray(payload.options)) return [];
  return payload.options.flatMap((option) => {
    if (typeof option === "string" && option.trim()) {
      return [{ label: option.trim(), description: option.trim() }];
    }
    if (!isRecord(option)) return [];
    const label = stringField(option, ["label", "name", "value"]);
    if (!label) return [];
    const description = stringField(option, ["description", "detail"]) ?? label;
    return [{ label, description }];
  });
}

function makeQuestions(payload: unknown) {
  const kind = extensionUiRequestKind(payload).toLowerCase();
  const question = extensionUiPrompt(payload);
  if (kind.includes("confirm")) {
    return [
      {
        id: "value",
        header: "Confirm",
        question,
        options: [
          { label: "Yes", description: "Approve this Pi request." },
          { label: "No", description: "Decline this Pi request." },
        ],
      },
    ];
  }
  const options = extensionUiOptions(payload);
  return [
    {
      id: "value",
      header: kind.includes("select") ? "Select" : "Input",
      question,
      ...(options.length > 0
        ? { options }
        : { options: [{ label: "Continue", description: "Continue with this Pi request." }] }),
    },
  ];
}

export const makePiAdapter = (opts?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const fileSystem = yield* FileSystem.FileSystem;
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const managedNativeEventLogger = opts?.nativeEventLogger
      ? undefined
      : opts?.nativeEventLogPath
        ? yield* makeEventNdjsonLogger(opts.nativeEventLogPath, { stream: "native" })
        : undefined;
    const nativeEventLogger = opts?.nativeEventLogger ?? managedNativeEventLogger;
    const sessions = new Map<ThreadId, PiSessionContext>();

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const logNative = (threadId: ThreadId, payload: unknown, source = "pi.rpc.event") =>
      nativeEventLogger?.write(
        {
          provider: PROVIDER,
          threadId,
          createdAt: nowIso(),
          raw: { source, payload },
        },
        threadId,
      ) ?? Effect.void;

    const requireSession = (threadId: ThreadId) =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.flatMap((ctx) =>
          ctx && !ctx.stopped
            ? Effect.succeed(ctx)
            : Effect.fail(
                new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
              ),
        ),
      );

    const stopSessionInternal = (ctx: PiSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        for (const [requestId, pending] of ctx.pendingUserInputs) {
          yield* Deferred.succeed(pending.answers, {}).pipe(Effect.ignore);
          ctx.pendingUserInputs.delete(requestId);
        }
        if (ctx.eventFiber) {
          yield* Fiber.interrupt(ctx.eventFiber);
        }
        yield* Effect.ignore(ctx.runtime.stop());
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...makeEventBase({ threadId: ctx.threadId }),
          payload: { exitKind: "graceful" },
        });
      });

    const applyModelSelection = (
      ctx: PiSessionContext,
      modelSelection: ProviderSendTurnInput["modelSelection"] | undefined,
    ) =>
      Effect.gen(function* () {
        if (modelSelection?.provider !== "pi") return;
        const parsed = parsePiModelSlug(modelSelection.model);
        if (parsed.modelId && parsed.provider) {
          yield* ctx.runtime
            .setModel(parsed.provider, parsed.modelId)
            .pipe(Effect.mapError((cause) => mapPiError(ctx.threadId, "set_model", cause)));
        }
        const effort = getModelSelectionStringOptionValue(modelSelection, "reasoningEffort");
        if (effort && effort !== "auto") {
          yield* ctx.runtime
            .setThinkingLevel(effort)
            .pipe(
              Effect.mapError((cause) => mapPiError(ctx.threadId, "set_thinking_level", cause)),
            );
        }
        ctx.session = {
          ...ctx.session,
          model: modelSelection.model,
          updatedAt: nowIso(),
        };
      });

    const handlePiRuntimeEvent = (ctx: PiSessionContext, event: PiRpcEvent) =>
      Effect.gen(function* () {
        yield* logNative(
          ctx.threadId,
          event.payload,
          event.kind === "response" ? "pi.rpc.response" : "pi.rpc.event",
        );
        if (event.kind === "exit") {
          if (!ctx.stopped) {
            yield* offerRuntimeEvent({
              type: "session.exited",
              ...makeEventBase({ threadId: ctx.threadId, raw: event.payload }),
              payload: { exitKind: "error" },
            });
          }
          return;
        }
        if (event.kind !== "event") return;
        const name = eventName(event.payload)?.toLowerCase() ?? "";
        if (name.includes("extension_ui_request")) {
          const requestId = extensionUiRequestId(event.payload) ?? randomUUID();
          const approvalRequestId = ApprovalRequestId.make(requestId);
          const answers = yield* Deferred.make<ProviderUserInputAnswers>();
          ctx.pendingUserInputs.set(approvalRequestId, { answers, requestId });
          yield* logNative(ctx.threadId, event.payload, "pi.rpc.extension_ui_request");
          yield* offerRuntimeEvent({
            type: "user-input.requested",
            ...makeEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              requestId,
              raw: event.payload,
            }),
            payload: { questions: makeQuestions(event.payload) },
            raw: {
              source: "pi.rpc.extension_ui_request",
              payload: event.payload,
            },
          });
          return;
        }

        if (name.includes("message") || name.includes("content")) {
          const delta = textDeltaFromPayload(event.payload);
          if (!delta) return;
          if (ctx.activePlanCapture) {
            const captured = appendAndCaptureProposedPlan(ctx.activePlanCapture, delta);
            if (captured.planMarkdown) {
              yield* offerRuntimeEvent({
                type: "turn.proposed.completed",
                ...makeEventBase({
                  threadId: ctx.threadId,
                  turnId: ctx.activeTurnId,
                  raw: event.payload,
                }),
                payload: { planMarkdown: captured.planMarkdown },
              });
            }
            if (captured.complete && captured.visibleText.length === 0) return;
          }
          yield* offerRuntimeEvent({
            type: "content.delta",
            ...makeEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              raw: event.payload,
            }),
            payload: { streamKind: "assistant_text", delta },
          });
          return;
        }

        if (name.includes("tool")) {
          const itemId = toolIdFromPayload(event.payload);
          const status =
            name.includes("end") || name.includes("complete") ? "completed" : "inProgress";
          yield* offerRuntimeEvent({
            type: status === "completed" ? "item.completed" : "item.updated",
            ...makeEventBase({
              threadId: ctx.threadId,
              turnId: ctx.activeTurnId,
              itemId,
              raw: event.payload,
            }),
            payload: {
              itemType: "dynamic_tool_call",
              status,
              ...(toolTitleFromPayload(event.payload)
                ? { title: toolTitleFromPayload(event.payload) }
                : {}),
              data: isRecord(event.payload) ? event.payload : { payload: event.payload },
            },
          });
          return;
        }

        if (name.includes("agent_end") || name.includes("turn_end")) {
          if (ctx.activeTurnId) {
            yield* offerRuntimeEvent({
              type: "turn.completed",
              ...makeEventBase({
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                raw: event.payload,
              }),
              payload: { state: "completed" },
            });
          }
        }
      });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }
        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* stopSessionInternal(existing);
        }

        const settings = yield* serverSettings.getSettings.pipe(
          Effect.map((value) => value.providers.pi),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "settings/read",
                detail: cause.message,
                cause,
              }),
          ),
        );
        const cwd = input.cwd.trim();
        const scope = yield* Scope.make("sequential");
        let transferred = false;
        yield* Effect.addFinalizer(() =>
          transferred ? Effect.void : Scope.close(scope, Exit.void),
        );

        const runtime = yield* (
          opts?.makeRuntime
            ? opts.makeRuntime({
                binaryPath: settings.binaryPath,
                cwd,
                ...(settings.configDir ? { configDir: settings.configDir } : {}),
              })
            : makePiRpcRuntime({
                binaryPath: settings.binaryPath,
                cwd,
                ...(settings.configDir ? { configDir: settings.configDir } : {}),
              })
        ).pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "runtime/start",
                detail: cause.message,
                cause,
              }),
          ),
        );

        const resume = parsePiResumeCursor(input.resumeCursor);
        if (resume.sessionFile) {
          yield* runtime.switchSession(resume.sessionFile).pipe(
            Effect.catch(() => runtime.newSession()),
            Effect.mapError((cause) => mapPiError(input.threadId, "switch_session", cause)),
          );
        } else {
          yield* runtime
            .newSession()
            .pipe(Effect.mapError((cause) => mapPiError(input.threadId, "new_session", cause)));
        }

        const state = yield* runtime.getState().pipe(Effect.catch(() => Effect.succeed({})));
        const now = nowIso();
        const session: ProviderSession = {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection?.provider === "pi" ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: piResumeCursorFromState(state),
          createdAt: now,
          updatedAt: now,
        };

        const ctx: PiSessionContext = {
          session,
          threadId: input.threadId,
          scope,
          runtime,
          turns: [],
          pendingUserInputs: new Map(),
          eventFiber: undefined,
          activeTurnId: undefined,
          activePlanCapture: undefined,
          stopped: false,
        };

        yield* applyModelSelection(ctx, input.modelSelection);
        const fiber = yield* Stream.runForEach(runtime.streamEvents, (event) =>
          handlePiRuntimeEvent(ctx, event).pipe(Effect.catch((cause) => Effect.logError(cause))),
        ).pipe(Effect.forkIn(scope), Effect.orDie);
        ctx.eventFiber = fiber;
        sessions.set(input.threadId, ctx);
        transferred = true;

        yield* offerRuntimeEvent({
          type: "session.started",
          ...makeEventBase({ threadId: input.threadId, raw: state }),
          payload: { resume: state },
        });
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          ...makeEventBase({ threadId: input.threadId }),
          payload: { state: "ready", reason: "Pi RPC session ready" },
        });
        yield* offerRuntimeEvent({
          type: "thread.started",
          ...makeEventBase({ threadId: input.threadId }),
          payload: {
            providerThreadId:
              parsePiResumeCursor(session.resumeCursor).sessionId ??
              parsePiResumeCursor(session.resumeCursor).sessionFile ??
              input.threadId,
          },
        });
        return ctx.session;
      }).pipe(Effect.scoped);

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        yield* applyModelSelection(ctx, input.modelSelection);
        const turnId = TurnId.make(randomUUID());
        ctx.activeTurnId = turnId;
        ctx.activePlanCapture =
          input.interactionMode === "plan" ? createPlanModeCaptureState() : undefined;
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: nowIso() };
        yield* offerRuntimeEvent({
          type: "turn.started",
          ...makeEventBase({ threadId: input.threadId, turnId }),
          payload: { model: ctx.session.model ?? "auto" },
        });

        const images = [];
        for (const attachment of input.attachments ?? []) {
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          });
          if (!attachmentPath) {
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          images.push({
            type: "image" as const,
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          });
        }

        const rawInput = input.input?.trim();
        if (!rawInput && images.length === 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text or attachments.",
          });
        }
        const message =
          input.interactionMode === "plan" && rawInput
            ? wrapPiPlanModePrompt(rawInput)
            : (rawInput ?? "");
        const result = yield* ctx.runtime
          .prompt({
            message,
            ...(images.length > 0 ? { images } : {}),
            streamingBehavior: ctx.turns.length > 0 ? "followUp" : "reject",
          })
          .pipe(Effect.mapError((cause) => mapPiError(input.threadId, "prompt", cause)));
        ctx.turns.push({ id: turnId, items: [{ input: message, images, result }] });
        ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: nowIso() };
        yield* offerRuntimeEvent({
          type: "turn.completed",
          ...makeEventBase({ threadId: input.threadId, turnId, raw: result }),
          payload: { state: "completed" },
        });
        return {
          threadId: input.threadId,
          turnId,
          resumeCursor: ctx.session.resumeCursor,
        };
      });

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        for (const [requestId, pending] of ctx.pendingUserInputs) {
          yield* Deferred.succeed(pending.answers, {}).pipe(Effect.ignore);
          ctx.pendingUserInputs.delete(requestId);
        }
        yield* ctx.runtime.abort().pipe(
          Effect.mapError((cause) => mapPiError(threadId, "abort", cause)),
          Effect.ignore,
        );
      });

    const respondToRequest: PiAdapterShape["respondToRequest"] = (threadId, requestId, _decision) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "respondToRequest",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "extension_ui_response",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }
        yield* ctx.runtime
          .respondExtensionUi(pending.requestId, answers)
          .pipe(Effect.mapError((cause) => mapPiError(threadId, "extension_ui_response", cause)));
        yield* Deferred.succeed(pending.answers, answers);
        ctx.pendingUserInputs.delete(requestId);
        yield* offerRuntimeEvent({
          type: "user-input.resolved",
          ...makeEventBase({ threadId, turnId: ctx.activeTurnId, requestId }),
          payload: { answers },
        });
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns })));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }
        ctx.turns.splice(Math.max(0, ctx.turns.length - numTurns));
        return { threadId, turns: ctx.turns };
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal));

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (ctx) => ({ ...ctx.session })));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const ctx = sessions.get(threadId);
        return ctx !== undefined && !ctx.stopped;
      });

    const stopAll: PiAdapterShape["stopAll"] = () =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      stopAll().pipe(
        Effect.ignore,
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
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
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies PiAdapterShape;
  });

export const PiAdapterLive = Layer.effect(PiAdapter, makePiAdapter());

export function makePiAdapterLive(opts?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(opts));
}
