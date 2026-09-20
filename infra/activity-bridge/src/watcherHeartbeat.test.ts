// @effect-diagnostics nodeBuiltinImport:off - Native helper token fixture.
// @effect-diagnostics globalDate:off - Simulate heartbeat timer jitter.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { OrchestrationV2ShellStreamItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import type { EnvironmentObservation } from "./feed.ts";
import { watchEnvironment } from "./watcher.ts";

const isRequest = Schema.is(
  Schema.TaggedStruct("Request", { id: Schema.Union([Schema.String, Schema.Number]) }),
);
const isPing = Schema.is(Schema.TaggedStruct("Ping", {}));
const snapshot = Schema.encodeSync(OrchestrationV2ShellStreamItem)({
  kind: "snapshot",
  snapshot: {
    ...v2ShellSnapshot,
    threads: [{ ...v2ThreadShell, status: "running" }],
  },
});
const controllers: AbortController[] = [];
const directories: string[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function connect(respondToPings: boolean) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "activity-heartbeat-"));
  directories.push(directory);
  const tokenPath = NodePath.join(directory, "token");
  NodeFS.writeFileSync(tokenPath, "read-only-test-token");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL) =>
      Response.json(
        url.pathname === "/.well-known/t3/environment"
          ? { environmentId: "box", orchestrationProtocolVersion: 2 }
          : { ticket: "test-ticket" },
      ),
    ),
  );
  const pings = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class extends EventTarget {
      readyState = 1;

      send(data: string) {
        const message: unknown = JSON.parse(data);
        if (isRequest(message)) {
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ _tag: "Chunk", requestId: message.id, values: [snapshot] }),
            }),
          );
        } else if (isPing(message)) {
          pings();
          if (respondToPings)
            this.dispatchEvent(new MessageEvent("message", { data: '{"_tag":"Pong"}' }));
        }
      }

      close() {
        this.readyState = 3;
        this.dispatchEvent(Object.assign(new Event("close"), { code: 1000, reason: "" }));
      }
    },
  );
  const controller = new AbortController();
  controllers.push(controller);
  const initialSnapshot = Promise.withResolvers<void>();
  const disconnected = vi.fn(() => controller.abort());
  const observation: EnvironmentObservation = {
    connected: false,
    snapshot: null,
    onSnapshot: () => initialSnapshot.resolve(),
    onDisconnect: disconnected,
  };
  const running = watchEnvironment(
    { url: "https://box.example.test", tokenPath, environmentId: "box" },
    observation,
    controller.signal,
  );
  await initialSnapshot.promise;
  return { observation, controller, running, pings, disconnected };
}

it("keeps quiet working threads connected when heartbeat timers run slightly late", async () => {
  const f = await connect(true);
  for (let tick = 0; tick < 6; tick++) {
    // A timer runs after its deadline on a real event loop, rather than exactly on it.
    vi.setSystemTime(Date.now() + 1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.observation.connected).toBe(true);
    expect(f.disconnected).not.toHaveBeenCalled();
    expect(f.pings).toHaveBeenCalledTimes(tick + 1);
  }
  f.controller.abort();
  await f.running;
});

it("still disconnects a server that stops answering heartbeats", async () => {
  const f = await connect(false);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.observation.connected).toBe(true);
  expect(f.pings).toHaveBeenCalledTimes(3);
  // Include the RPC client's one-second cancellation timeout after the socket closes.
  await vi.advanceTimersByTimeAsync(6_000);
  await f.running;
  expect(f.observation.connected).toBe(false);
  expect(f.disconnected).toHaveBeenCalledOnce();
});
