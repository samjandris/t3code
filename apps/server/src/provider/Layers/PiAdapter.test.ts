import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PiAdapter } from "../Services/PiAdapter.ts";
import { type PiRpcEvent, type PiRpcRuntimeShape } from "../pi/PiRpcRuntime.ts";
import {
  isPiTurnCompletionPayload,
  makePiAdapterLive,
  piToolDetail,
  piToolItemType,
  textDeltaFromPiPayload,
} from "./PiAdapter.ts";

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

function makePromptResolvingRuntime(events: Queue.Queue<PiRpcEvent>): PiRpcRuntimeShape {
  const request = (_method: string, _params?: unknown) => Effect.succeed({});
  return {
    request,
    prompt: () => Effect.succeed({ done: true }),
    abort: () => request("abort"),
    newSession: () => request("new_session"),
    switchSession: (sessionPath) => request("switch_session", { sessionPath }),
    getState: () => Effect.succeed({ sessionId: "pi-session-1", sessionName: "Pi test" }),
    getMessages: () => request("get_messages"),
    getAvailableModels: () => request("get_available_models"),
    setModel: (provider, modelId) => request("set_model", { provider, modelId }),
    setThinkingLevel: (level) => request("set_thinking_level", { level }),
    getSessionStats: () => request("get_session_stats"),
    respondExtensionUi: (requestId, response) =>
      request("extension_ui_response", { requestId, response }),
    stop: () => Effect.void,
    streamEvents: Stream.fromQueue(events),
  };
}

const promptCompletionPiEvents = Effect.runSync(Queue.unbounded<PiRpcEvent>());
const PromptLifecyclePiAdapterTestLayer = makePiAdapterLive({
  makeRuntime: () => Effect.succeed(makePromptResolvingRuntime(promptCompletionPiEvents)),
}).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);

describe("PiAdapter", () => {
  it("extracts documented Pi message_update text deltas", () => {
    assert.equal(
      textDeltaFromPiPayload({
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello from Pi",
        },
      }),
      "Hello from Pi",
    );
  });

  it("preserves whitespace in streamed text deltas", () => {
    assert.equal(
      textDeltaFromPiPayload({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: " world ",
        },
      }),
      " world ",
    );
  });

  it("ignores non-text Pi message_update deltas", () => {
    assert.equal(
      textDeltaFromPiPayload({
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "internal thought",
        },
      }),
      undefined,
    );
  });

  it("does not treat assistant message completion as turn completion", () => {
    assert.isFalse(
      isPiTurnCompletionPayload({
        type: "message_update",
        assistantMessageEvent: {
          type: "done",
          stopReason: "toolUse",
        },
      }),
    );
  });

  it("treats Pi agent end as turn completion", () => {
    assert.isTrue(isPiTurnCompletionPayload({ type: "agent_end" }));
  });

  it("does not treat Pi turn end as turn completion", () => {
    assert.isFalse(isPiTurnCompletionPayload({ type: "turnEnd" }));
  });

  it("classifies documented Pi bash tool events as command execution", () => {
    assert.equal(piToolItemType("bash"), "command_execution");
    assert.equal(
      piToolDetail({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "ls -la" },
      }),
      "ls -la",
    );
  });

  it("extracts streamed and final Pi tool output details", () => {
    assert.equal(
      piToolDetail({
        type: "tool_execution_update",
        partialResult: {
          content: [{ type: "text", text: "partial output" }],
        },
      }),
      "partial output",
    );
    assert.equal(
      piToolDetail({
        type: "tool_execution_end",
        result: {
          content: [{ type: "text", text: "final output" }],
        },
      }),
      "final output",
    );
  });

  it.layer(PromptLifecyclePiAdapterTestLayer)("prompt lifecycle", (it) => {
    it.effect("does not complete the active T3 turn when Pi accepts the prompt", () =>
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const threadId = asThreadId("thread-pi-prompt-accepted");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "draft a plan",
          interactionMode: "plan",
        });
        const sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.activeTurnId, turn.turnId);
        const snapshot = yield* adapter.readThread(threadId);
        assert.equal(snapshot.turns[0]?.id, turn.turnId);
        yield* adapter.stopSession(threadId);
      }),
    );
  });

  it.layer(PromptLifecyclePiAdapterTestLayer)("assistant streaming", (it) => {
    it.effect("keeps Pi text deltas on the active turn until Pi agent_end", () =>
      Effect.gen(function* () {
        const adapter = yield* PiAdapter;
        const runtimeEvents: Array<ProviderRuntimeEvent> = [];
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }),
        ).pipe(Effect.forkChild);
        const threadId = asThreadId("thread-pi-active-turn-deltas");
        yield* adapter.startSession({
          provider: "pi",
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        const turn = yield* adapter.sendTurn({ threadId, input: "hi" });
        yield* Queue.offer(promptCompletionPiEvents, {
          kind: "event",
          payload: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: "Hi",
            },
          },
        });
        yield* Queue.offer(promptCompletionPiEvents, {
          kind: "event",
          payload: {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: " there",
            },
          },
        });
        let sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.activeTurnId, turn.turnId);
        yield* Queue.offer(promptCompletionPiEvents, {
          kind: "event",
          payload: {
            type: "turn_end",
            message: {
              role: "assistant",
              content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
              stopReason: "toolUse",
            },
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.activeTurnId, turn.turnId);
        assert.isUndefined(runtimeEvents.find((event) => event.type === "turn.completed"));
        yield* Queue.offer(promptCompletionPiEvents, {
          kind: "event",
          payload: {
            type: "agent_end",
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Hi there" }],
              },
            ],
          },
        });
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(runtimeEventsFiber);
        const deltas = runtimeEvents.filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta",
        );
        assert.equal(deltas.length, 2);
        assert.equal(String(deltas[0]?.turnId), String(turn.turnId));
        assert.equal(String(deltas[1]?.turnId), String(turn.turnId));
        const completed = runtimeEvents.find((event) => event.type === "turn.completed");
        assert.equal(String(completed?.turnId), String(turn.turnId));
        sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.activeTurnId, undefined);
        yield* adapter.stopSession(threadId);
      }),
    );
  });
});
