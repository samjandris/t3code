import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { Deferred, Effect, Exit, Layer, Queue, Scope, Stream } from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";

const PROVIDER = "pi" as const;
const PI_RESUME_VERSION = 1 as const;

type PiRpcResponse = {
  readonly id?: string;
  readonly type: "response";
  readonly command?: string;
  readonly success: boolean;
  readonly error?: string;
  readonly data?: unknown;
};

type PiRpcEvent = Record<string, unknown> & { readonly type?: string };

interface PendingCommand {
  readonly command: string;
  readonly response: Deferred.Deferred<PiRpcResponse>;
}

interface PendingUserInput {
  readonly id: string;
  readonly method: string;
}

interface PiTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface PiSessionContext {
  session: ProviderSession;
  readonly child: ChildProcessWithoutNullStreams;
  readonly scope: Scope.Closeable;
  readonly pendingCommands: Map<string, PendingCommand>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<PiTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  stdoutBuffer: string;
  stopped: boolean;
}

export interface PiAdapterLiveOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePiResume(raw: unknown): { sessionFile: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== PI_RESUME_VERSION) return undefined;
  return typeof raw.sessionFile === "string" && raw.sessionFile.trim()
    ? { sessionFile: raw.sessionFile.trim() }
    : undefined;
}

function parsePiModelSlug(
  model: string | null | undefined,
): { readonly provider?: string; readonly modelId: string } | undefined {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "default") return undefined;
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
    return { modelId: trimmed };
  }
  return {
    provider: trimmed.slice(0, slashIndex),
    modelId: trimmed.slice(slashIndex + 1),
  };
}

function providerSessionResumeCursor(event: PiRpcEvent): unknown | undefined {
  if (event.type !== "agent_end" || !isRecord(event.state)) {
    return undefined;
  }
  const sessionFile = event.state.sessionFile;
  return typeof sessionFile === "string" && sessionFile.trim()
    ? { schemaVersion: PI_RESUME_VERSION, sessionFile: sessionFile.trim() }
    : undefined;
}

function buildEventBase(input: {
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
    ...(input.raw !== undefined ? { raw: { source: "pi.rpc.event", payload: input.raw } } : {}),
  };
}

function updateProviderSession(
  context: PiSessionContext,
  patch: Partial<ProviderSession>,
  options?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
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

function appendTurnItem(context: PiSessionContext, item: unknown): void {
  const turnId = context.activeTurnId;
  if (!turnId) return;
  let turn = context.turns.find((candidate) => candidate.id === turnId);
  if (!turn) {
    turn = { id: turnId, items: [] };
    context.turns.push(turn);
  }
  turn.items.push(item);
}

function toolItemType(
  toolName: string,
): "command_execution" | "file_change" | "web_search" | "image_view" | "dynamic_tool_call" {
  const lower = toolName.toLowerCase();
  if (lower.includes("bash") || lower.includes("command")) return "command_execution";
  if (lower.includes("edit") || lower.includes("write")) return "file_change";
  if (lower.includes("web")) return "web_search";
  if (lower.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

function textFromToolResult(result: unknown): string | undefined {
  if (!isRecord(result)) return undefined;
  const content = result.content;
  if (!Array.isArray(content)) return undefined;
  return content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function makeUserInputQuestion(event: PiRpcEvent): UserInputQuestion | undefined {
  if (event.type !== "extension_ui_request") return undefined;
  const method = typeof event.method === "string" ? event.method : "";
  const id = typeof event.id === "string" ? event.id : "";
  if (!id || !["select", "confirm", "input", "editor"].includes(method)) {
    return undefined;
  }
  const title = typeof event.title === "string" && event.title.trim() ? event.title : "Pi request";
  const message =
    typeof event.message === "string" && event.message.trim()
      ? event.message
      : method === "confirm"
        ? "Confirm this action."
        : method === "select"
          ? "Choose an option."
          : "Provide a response.";
  const options =
    method === "select" && Array.isArray(event.options)
      ? event.options
          .filter((option): option is string => typeof option === "string" && option.trim() !== "")
          .map((label) => ({ label, description: label }))
      : method === "confirm"
        ? [
            { label: "Yes", description: "Confirm" },
            { label: "No", description: "Cancel" },
          ]
        : [{ label: "Submit", description: "Submit the response" }];
  return {
    id,
    header: title,
    question: message,
    options,
  };
}

function answerForPiUiResponse(method: string, id: string, answers: ProviderUserInputAnswers) {
  const value = answers[id] ?? answers.value ?? answers.response;
  if (method === "confirm") {
    return { confirmed: value === true || value === "Yes" || value === "yes" };
  }
  if (typeof value === "string") {
    return { value };
  }
  if (value === undefined || value === null) {
    return { cancelled: true };
  }
  return { value: String(value) };
}

function piCommandError(input: {
  readonly method: string;
  readonly detail: string;
  readonly cause?: unknown;
}): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: input.method,
    detail: input.detail,
    cause: input.cause,
  });
}

function forkPiEffect(effect: Effect.Effect<void, never, never>): void {
  Effect.runFork(effect);
}

function isProviderAdapterStartError(
  cause: unknown,
): cause is ProviderAdapterValidationError | ProviderAdapterProcessError {
  return (
    isRecord(cause) &&
    (cause._tag === "ProviderAdapterValidationError" ||
      cause._tag === "ProviderAdapterProcessError")
  );
}

export function makePiAdapterLive(_options?: PiAdapterLiveOptions) {
  return Layer.effect(
    PiAdapter,
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
      const sessions = new Map<ThreadId, PiSessionContext>();

      const emit = (event: ProviderRuntimeEvent) =>
        Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

      const requireSession = (
        threadId: ThreadId,
      ): Effect.Effect<
        PiSessionContext,
        ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
      > => {
        const context = sessions.get(threadId);
        if (!context) {
          return Effect.fail(
            new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
          );
        }
        if (context.stopped) {
          return Effect.fail(
            new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId }),
          );
        }
        return Effect.succeed(context);
      };

      const writeCommand = (
        context: PiSessionContext,
        command: Record<string, unknown>,
      ): Effect.Effect<void, ProviderAdapterRequestError> =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              context.child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
                if (error) reject(error);
                else resolve();
              });
            }),
          catch: (cause) =>
            piCommandError({
              method: String(command.type ?? "unknown"),
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        });

      const sendCommand = (
        context: PiSessionContext,
        command: Record<string, unknown>,
      ): Effect.Effect<PiRpcResponse, ProviderAdapterRequestError> =>
        Effect.gen(function* () {
          const id = randomUUID();
          const response = yield* Deferred.make<PiRpcResponse>();
          context.pendingCommands.set(id, {
            command: String(command.type ?? "unknown"),
            response,
          });
          yield* writeCommand(context, { id, ...command });
          const result = yield* Deferred.await(response);
          if (!result.success) {
            return yield* piCommandError({
              method: result.command ?? String(command.type ?? "unknown"),
              detail: result.error ?? "Pi RPC command failed.",
              cause: result,
            });
          }
          return result;
        });

      const stopContext = (context: PiSessionContext) =>
        Effect.gen(function* () {
          if (context.stopped) return;
          context.stopped = true;
          sessions.delete(context.session.threadId);
          for (const pending of context.pendingCommands.values()) {
            yield* Deferred.succeed(pending.response, {
              id: "",
              type: "response",
              command: pending.command,
              success: false,
              error: "Pi session stopped.",
            }).pipe(Effect.ignore);
          }
          context.pendingCommands.clear();
          context.child.kill("SIGTERM");
          yield* Scope.close(context.scope, Exit.void);
          yield* emit({
            ...buildEventBase({ threadId: context.session.threadId }),
            type: "session.exited",
            payload: { exitKind: "graceful" },
          }).pipe(Effect.ignore);
        });

      const handlePiEvent = (context: PiSessionContext, event: PiRpcEvent) =>
        Effect.gen(function* () {
          const response = event.type === "response" ? (event as PiRpcResponse) : undefined;
          if (response?.id) {
            const pending = context.pendingCommands.get(response.id);
            if (pending) {
              context.pendingCommands.delete(response.id);
              yield* Deferred.succeed(pending.response, response).pipe(Effect.ignore);
              return;
            }
          }

          appendTurnItem(context, event);
          const turnId = context.activeTurnId;
          switch (event.type) {
            case "agent_start":
              updateProviderSession(
                context,
                { status: "running", activeTurnId: turnId },
                { clearLastError: true },
              );
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "session.state.changed",
                payload: { state: "running" },
              });
              break;
            case "agent_end":
              updateProviderSession(
                context,
                { status: "ready", resumeCursor: providerSessionResumeCursor(event) },
                { clearActiveTurnId: true, clearLastError: true },
              );
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "turn.completed",
                payload: { state: "completed", stopReason: "stop" },
              });
              context.activeTurnId = undefined;
              break;
            case "turn_start":
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "turn.started",
                payload: { model: context.session.model },
              });
              break;
            case "turn_end":
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "turn.completed",
                payload: { state: "completed", stopReason: "stop" },
              });
              break;
            case "message_update": {
              const assistantMessageEvent = isRecord(event.assistantMessageEvent)
                ? event.assistantMessageEvent
                : undefined;
              const type = assistantMessageEvent?.type;
              const delta =
                typeof assistantMessageEvent?.delta === "string" ? assistantMessageEvent.delta : "";
              if (delta.length > 0 && (type === "text_delta" || type === "thinking_delta")) {
                yield* emit({
                  ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                  type: "content.delta",
                  payload: {
                    streamKind: type === "thinking_delta" ? "reasoning_text" : "assistant_text",
                    delta,
                  },
                });
              }
              break;
            }
            case "message_end":
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "item.completed",
                payload: {
                  itemType: "assistant_message",
                  status: "completed",
                  title: "Assistant message",
                },
              });
              break;
            case "tool_execution_start": {
              const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
              const toolCallId =
                typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: toolCallId,
                  raw: event,
                }),
                type: "item.started",
                payload: {
                  itemType: toolItemType(toolName),
                  status: "inProgress",
                  title: toolName,
                  data: { args: event.args },
                },
              });
              break;
            }
            case "tool_execution_update": {
              const detail = textFromToolResult(event.partialResult);
              if (detail) {
                yield* emit({
                  ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                  type: "content.delta",
                  payload: {
                    streamKind: "command_output",
                    delta: detail,
                  },
                });
              }
              break;
            }
            case "tool_execution_end": {
              const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
              const toolCallId =
                typeof event.toolCallId === "string" ? event.toolCallId : randomUUID();
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  itemId: toolCallId,
                  raw: event,
                }),
                type: "item.completed",
                payload: {
                  itemType: toolItemType(toolName),
                  status: event.isError === true ? "failed" : "completed",
                  title: toolName,
                  ...(textFromToolResult(event.result)
                    ? { detail: textFromToolResult(event.result) }
                    : {}),
                },
              });
              break;
            }
            case "compaction_start":
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "item.started",
                payload: {
                  itemType: "context_compaction",
                  status: "inProgress",
                  title: "Compacting context",
                },
              });
              break;
            case "compaction_end":
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "item.completed",
                payload: {
                  itemType: "context_compaction",
                  status: event.aborted === true ? "failed" : "completed",
                  title: "Context compacted",
                },
              });
              break;
            case "extension_ui_request": {
              const question = makeUserInputQuestion(event);
              if (!question) break;
              const requestId = ApprovalRequestId.make(question.id);
              const method = typeof event.method === "string" ? event.method : "input";
              context.pendingUserInputs.set(requestId, { id: question.id, method });
              yield* emit({
                ...buildEventBase({
                  threadId: context.session.threadId,
                  turnId,
                  requestId,
                  raw: event,
                }),
                type: "user-input.requested",
                payload: { questions: [question] },
              });
              break;
            }
            case "extension_error":
              yield* emit({
                ...buildEventBase({ threadId: context.session.threadId, turnId, raw: event }),
                type: "runtime.error",
                payload: {
                  message: typeof event.error === "string" ? event.error : "Pi extension failed.",
                  class: "provider_error",
                },
              });
              break;
          }
        });

      const consumeStdout = (context: PiSessionContext, chunk: Buffer) => {
        context.stdoutBuffer += chunk.toString("utf8");
        while (true) {
          const newline = context.stdoutBuffer.indexOf("\n");
          if (newline === -1) break;
          const line = context.stdoutBuffer.slice(0, newline).replace(/\r$/, "");
          context.stdoutBuffer = context.stdoutBuffer.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as PiRpcEvent;
            forkPiEffect(handlePiEvent(context, event));
          } catch (cause) {
            Queue.offerUnsafe(runtimeEvents, {
              ...buildEventBase({ threadId: context.session.threadId, raw: { line } }),
              type: "runtime.warning",
              payload: {
                message: "Failed to parse Pi RPC event.",
                detail: cause instanceof Error ? cause.message : String(cause),
              },
            });
          }
        }
      };

      yield* Effect.addFinalizer(() =>
        Effect.forEach([...sessions.values()], stopContext, {
          concurrency: "unbounded",
          discard: true,
        }),
      );

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
          if (existing) {
            yield* stopContext(existing);
          }

          const settings = (yield* serverSettings.getSettings).providers.pi;
          const modelSelection =
            input.modelSelection?.provider === PROVIDER ? input.modelSelection : undefined;
          const cwd = nodePath.resolve(input.cwd.trim());
          const sessionDir = nodePath.join(serverConfig.stateDir, "pi-sessions");
          yield* Effect.promise(() => fs.mkdir(sessionDir, { recursive: true }));

          const resume = parsePiResume(input.resumeCursor);
          const args = [
            "--mode",
            "rpc",
            "--session-dir",
            sessionDir,
            ...(resume ? ["--session", resume.sessionFile] : []),
            ...(modelSelection?.model && modelSelection.model !== "default"
              ? ["--model", modelSelection.model]
              : []),
          ];

          const child = spawn(settings.binaryPath, args, {
            cwd,
            stdio: "pipe",
            env: process.env,
          });

          const scope = yield* Scope.make("sequential");
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model ?? "default",
            threadId: input.threadId,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          const context: PiSessionContext = {
            session,
            child,
            scope,
            pendingCommands: new Map(),
            pendingUserInputs: new Map(),
            turns: [],
            activeTurnId: undefined,
            stdoutBuffer: "",
            stopped: false,
          };
          sessions.set(input.threadId, context);

          child.stdout.on("data", (chunk: Buffer) => consumeStdout(context, chunk));
          child.stderr.on("data", (chunk: Buffer) => {
            const detail = chunk.toString("utf8").trim();
            if (!detail) return;
            Queue.offerUnsafe(runtimeEvents, {
              ...buildEventBase({ threadId: input.threadId, raw: { stderr: detail } }),
              type: "runtime.warning",
              payload: { message: "Pi wrote to stderr.", detail },
            });
          });
          child.on("error", (cause) => {
            updateProviderSession(context, {
              status: "error",
              lastError: cause.message,
            });
            Queue.offerUnsafe(runtimeEvents, {
              ...buildEventBase({ threadId: input.threadId }),
              type: "runtime.error",
              payload: { message: cause.message, class: "transport_error" },
            });
          });
          child.on("exit", (code, signal) => {
            if (context.stopped) return;
            context.stopped = true;
            sessions.delete(input.threadId);
            const reason = `Pi exited with code ${code ?? "null"} signal ${signal ?? "null"}.`;
            updateProviderSession(
              context,
              { status: "closed", lastError: reason },
              { clearActiveTurnId: true },
            );
            Queue.offerUnsafe(runtimeEvents, {
              ...buildEventBase({ threadId: input.threadId, turnId: context.activeTurnId }),
              type: "session.exited",
              payload: { reason, recoverable: false, exitKind: code === 0 ? "graceful" : "error" },
            });
          });

          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "session.started",
            payload: { message: "Pi RPC session started." },
          });
          yield* emit({
            ...buildEventBase({ threadId: input.threadId }),
            type: "thread.started",
            payload: {},
          });

          return session;
        }).pipe(
          Effect.mapError((cause) =>
            isProviderAdapterStartError(cause)
              ? cause
              : new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: cause instanceof Error ? cause.message : String(cause),
                  cause,
                }),
          ),
        );

      const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          const turnId = TurnId.make(randomUUID());
          context.activeTurnId = turnId;
          updateProviderSession(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              ...(input.modelSelection?.provider === PROVIDER
                ? { model: input.modelSelection.model }
                : {}),
            },
            { clearLastError: true },
          );

          const images = yield* Effect.forEach(
            input.attachments ?? [],
            (attachment) =>
              Effect.gen(function* () {
                const filePath = resolveAttachmentPath({
                  attachmentsDir: serverConfig.attachmentsDir,
                  attachment,
                });
                if (!filePath) {
                  return yield* new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "readAttachment",
                    detail: `Invalid attachment path for ${attachment.id}.`,
                  });
                }
                const data = yield* Effect.tryPromise({
                  try: () => fs.readFile(filePath, "base64"),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "readAttachment",
                      detail: cause instanceof Error ? cause.message : String(cause),
                      cause,
                    }),
                });
                return { type: "image", data, mimeType: attachment.mimeType };
              }),
            { concurrency: "unbounded" },
          );

          if (
            input.modelSelection?.provider === PROVIDER &&
            input.modelSelection.model !== "default"
          ) {
            const parsedModel = parsePiModelSlug(input.modelSelection.model);
            yield* sendCommand(context, {
              type: "set_model",
              ...(parsedModel?.provider ? { provider: parsedModel.provider } : {}),
              modelId: parsedModel?.modelId ?? input.modelSelection.model,
            });
            const thinkingLevel = getModelSelectionStringOptionValue(
              input.modelSelection,
              "thinkingLevel",
            );
            if (thinkingLevel) {
              yield* sendCommand(context, {
                type: "set_thinking_level",
                level: thinkingLevel,
              });
            }
          }

          const commandType =
            context.session.status === "running" && input.interactionMode !== "default"
              ? "follow_up"
              : "prompt";
          yield* emit({
            ...buildEventBase({ threadId: input.threadId, turnId }),
            type: "turn.started",
            payload: { model: context.session.model },
          });
          yield* sendCommand(context, {
            type: commandType,
            message: input.input ?? "",
            ...(images.length > 0 ? { images } : {}),
          });
          return { threadId: input.threadId, turnId, resumeCursor: context.session.resumeCursor };
        });

      return {
        provider: PROVIDER,
        capabilities: { sessionModelSwitch: "in-session" },
        startSession,
        sendTurn,
        interruptTurn: (threadId) =>
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            yield* sendCommand(context, { type: "abort" }).pipe(Effect.ignore);
            updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
            yield* emit({
              ...buildEventBase({ threadId, turnId: context.activeTurnId }),
              type: "turn.aborted",
              payload: { reason: "Interrupted by user." },
            });
            context.activeTurnId = undefined;
          }),
        respondToRequest: (threadId, requestId, decision: ProviderApprovalDecision) =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "respondToRequest",
              detail: `Pi does not expose native approval requests. Received ${decision} for ${requestId}.`,
            }),
          ),
        respondToUserInput: (threadId, requestId, answers: ProviderUserInputAnswers) =>
          Effect.gen(function* () {
            const context = yield* requireSession(threadId);
            const pending = context.pendingUserInputs.get(requestId);
            if (!pending) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "extension_ui_response",
                detail: `Unknown Pi user input request: ${requestId}`,
              });
            }
            context.pendingUserInputs.delete(requestId);
            yield* writeCommand(context, {
              type: "extension_ui_response",
              id: pending.id,
              ...answerForPiUiResponse(pending.method, pending.id, answers),
            });
            yield* emit({
              ...buildEventBase({ threadId, requestId }),
              type: "user-input.resolved",
              payload: { answers },
            });
          }),
        stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopContext)),
        listSessions: () =>
          Effect.succeed([...sessions.values()].map((context) => context.session)),
        hasSession: (threadId) =>
          Effect.succeed(sessions.has(ThreadId.make(threadId))).pipe(
            Effect.orElseSucceed(() => sessions.has(threadId)),
          ),
        readThread: (threadId) =>
          requireSession(threadId).pipe(
            Effect.map((context) => ({
              threadId,
              turns: context.turns,
            })),
          ),
        rollbackThread: (threadId, numTurns) =>
          requireSession(threadId).pipe(
            Effect.flatMap((context) =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "rollbackThread",
                  detail: `Pi RPC does not currently expose rollback; requested ${numTurns} turn(s).`,
                  cause: { turns: context.turns.length },
                }),
              ),
            ),
          ),
        stopAll: () =>
          Effect.forEach([...sessions.values()], stopContext, {
            concurrency: "unbounded",
            discard: true,
          }),
        streamEvents: Stream.fromQueue(runtimeEvents),
      } satisfies PiAdapterShape;
    }),
  );
}
