import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Data, Deferred, Effect, PubSub, Queue, Scope, Stream } from "effect";

export class PiRpcRuntimeError extends Data.TaggedError("PiRpcRuntimeError")<{
  readonly operation: string;
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return `${this.operation}: ${this.detail}`;
  }
}

export interface PiRpcSpawnOptions {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly configDir?: string | undefined;
  readonly noSession?: boolean | undefined;
}

export type PiRpcWireMessage =
  | {
      readonly type?: "response";
      readonly id?: string | number;
      readonly success?: boolean;
      readonly result?: unknown;
      readonly error?: unknown;
      readonly [key: string]: unknown;
    }
  | {
      readonly type?: string;
      readonly event?: string;
      readonly [key: string]: unknown;
    };

export interface PiRpcEvent {
  readonly kind: "event" | "response" | "stderr" | "exit" | "parse-error";
  readonly payload: unknown;
}

export interface PiPromptInput {
  readonly message: string;
  readonly images?: ReadonlyArray<{
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
  }>;
  readonly streamingBehavior?: "reject" | "followUp" | "steer";
}

export interface PiRpcRuntimeShape {
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly prompt: (input: PiPromptInput) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly abort: () => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly newSession: (parentSession?: string) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly switchSession: (sessionPath: string) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly getState: () => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly getMessages: () => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly getAvailableModels: () => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly setModel: (
    provider: string,
    modelId: string,
  ) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly setThinkingLevel: (level: string) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly getSessionStats: () => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly respondExtensionUi: (
    requestId: string,
    response: unknown,
  ) => Effect.Effect<unknown, PiRpcRuntimeError>;
  readonly stop: () => Effect.Effect<void>;
  readonly streamEvents: Stream.Stream<PiRpcEvent>;
}

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, PiRpcRuntimeError>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageId(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const id = message.id;
  if (typeof id === "string") return id;
  if (typeof id === "number") return String(id);
  return undefined;
}

function isResponse(message: unknown): boolean {
  return isRecord(message) && (message.type === "response" || messageId(message) !== undefined);
}

function responseSucceeded(message: Record<string, unknown>): boolean {
  return message.success !== false && message.error === undefined;
}

function responseResult(message: Record<string, unknown>): unknown {
  if ("result" in message) return message.result;
  if ("data" in message) return message.data;
  return message;
}

function responseErrorDetail(message: Record<string, unknown>): string {
  const error = message.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return "Pi RPC request failed.";
}

function parseJsonLine(line: string): unknown {
  return JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
}

export const makePiRpcRuntime = (
  options: PiRpcSpawnOptions,
): Effect.Effect<PiRpcRuntimeShape, PiRpcRuntimeError, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const eventPubSub = yield* PubSub.unbounded<PiRpcEvent>();
    const pending = new Map<string, PendingRequest>();
    const args = ["--mode", "rpc", ...(options.noSession ? ["--no-session"] : [])];
    const child = spawn(options.binaryPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.configDir ? { PI_CODING_AGENT_DIR: options.configDir } : {}),
      },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    let stopped = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";

    const failAllPending = (detail: string, cause?: unknown) => {
      for (const { method, deferred } of pending.values()) {
        Effect.runFork(
          Deferred.fail(
            deferred,
            new PiRpcRuntimeError({
              operation: method,
              detail,
              cause,
            }),
          ),
        );
      }
      pending.clear();
    };

    const publish = (event: PiRpcEvent) => Effect.runFork(PubSub.publish(eventPubSub, event));

    const handleMessage = (payload: unknown) => {
      if (isResponse(payload)) {
        publish({ kind: "response", payload });
        const id = messageId(payload);
        const pendingRequest = id ? pending.get(id) : undefined;
        if (!pendingRequest || !isRecord(payload)) return;
        pending.delete(id!);
        if (responseSucceeded(payload)) {
          Effect.runFork(Deferred.succeed(pendingRequest.deferred, responseResult(payload)));
          return;
        }
        Effect.runFork(
          Deferred.fail(
            pendingRequest.deferred,
            new PiRpcRuntimeError({
              operation: pendingRequest.method,
              detail: responseErrorDetail(payload),
              cause: payload,
            }),
          ),
        );
        return;
      }
      publish({ kind: "event", payload });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      for (;;) {
        const index = stdoutBuffer.indexOf("\n");
        if (index < 0) break;
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line.trim().length === 0) continue;
        try {
          handleMessage(parseJsonLine(line));
        } catch (cause) {
          publish({ kind: "parse-error", payload: { line, cause } });
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString("utf8");
      const text = chunk.toString("utf8");
      publish({ kind: "stderr", payload: text });
    });

    child.on("error", (cause) => {
      const detail = cause instanceof Error ? cause.message : "Pi RPC process error.";
      failAllPending(detail, cause);
      publish({ kind: "exit", payload: { exitKind: "error", detail } });
    });

    child.on("exit", (code, signal) => {
      if (!stopped) {
        const detail = `Pi RPC process exited${code !== null ? ` with code ${code}` : ""}${signal ? ` due to ${signal}` : ""}.`;
        failAllPending(detail);
      }
      publish({
        kind: "exit",
        payload: {
          exitKind: stopped ? "graceful" : "error",
          code,
          signal,
          stderr: stderrBuffer.trim() || undefined,
        },
      });
    });

    const stop = Effect.gen(function* () {
      yield* Effect.sync(() => {
        stopped = true;
        failAllPending("Pi RPC process stopped.");
        if (!child.killed) child.kill();
      });
      yield* PubSub.shutdown(eventPubSub);
    });

    yield* Scope.addFinalizer(scope, stop);

    const request: PiRpcRuntimeShape["request"] = (method, params) =>
      Effect.gen(function* () {
        if (stopped) {
          return yield* new PiRpcRuntimeError({
            operation: method,
            detail: "Pi RPC process is stopped.",
          });
        }
        const id = randomUUID();
        const deferred = yield* Deferred.make<unknown, PiRpcRuntimeError>();
        pending.set(id, { method, deferred });
        const payload = params === undefined ? { id, method } : { id, method, params };
        const line = `${JSON.stringify(payload)}\n`;
        yield* Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              child.stdin.write(line, (cause) => {
                if (cause) {
                  reject(cause);
                } else {
                  resolve();
                }
              });
            }),
          catch: (cause) => {
            pending.delete(id);
            return new PiRpcRuntimeError({
              operation: method,
              detail: cause instanceof Error ? cause.message : "Failed to write Pi RPC request.",
              cause,
            });
          },
        });
        return yield* Deferred.await(deferred);
      });

    return {
      request,
      prompt: (input) => request("prompt", input),
      abort: () => request("abort"),
      newSession: (parentSession) =>
        request("new_session", parentSession ? { parentSession } : undefined),
      switchSession: (sessionPath) => request("switch_session", { sessionPath }),
      getState: () => request("get_state"),
      getMessages: () => request("get_messages"),
      getAvailableModels: () => request("get_available_models"),
      setModel: (provider, modelId) => request("set_model", { provider, model: modelId, modelId }),
      setThinkingLevel: (level) => request("set_thinking_level", { level }),
      getSessionStats: () => request("get_session_stats"),
      respondExtensionUi: (requestId, response) =>
        request("extension_ui_response", { requestId, response }),
      stop: () => stop,
      streamEvents: Stream.fromPubSub(eventPubSub),
    } satisfies PiRpcRuntimeShape;
  });

export function makePiRpcRuntimeForTest(
  events: Queue.Queue<PiRpcEvent>,
  requests: Array<{ method: string; params: unknown }>,
): PiRpcRuntimeShape {
  const request = (method: string, params?: unknown) =>
    Effect.sync(() => {
      requests.push({ method, params });
      return {};
    });
  return {
    request,
    prompt: (input) => request("prompt", input),
    abort: () => request("abort"),
    newSession: (parentSession) =>
      request("new_session", parentSession ? { parentSession } : undefined),
    switchSession: (sessionPath) => request("switch_session", { sessionPath }),
    getState: () => request("get_state"),
    getMessages: () => request("get_messages"),
    getAvailableModels: () => request("get_available_models"),
    setModel: (provider, modelId) => request("set_model", { provider, model: modelId, modelId }),
    setThinkingLevel: (level) => request("set_thinking_level", { level }),
    getSessionStats: () => request("get_session_stats"),
    respondExtensionUi: (requestId, response) =>
      request("extension_ui_response", { requestId, response }),
    stop: () => Effect.void,
    streamEvents: Stream.fromQueue(events),
  };
}
