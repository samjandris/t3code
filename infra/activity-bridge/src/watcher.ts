// @effect-diagnostics nodeBuiltinImport:off - Native Node helper runtime.
// @effect-diagnostics globalFetch:off - Native Node helper runtime.
// @effect-diagnostics globalConsole:off - Native Node helper runtime.
// @effect-diagnostics globalDateInEffect:off - Native Node helper runtime.
// @effect-diagnostics globalConsoleInEffect:off - Native Node helper runtime.
import * as NodeFS from "node:fs";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeTimersPromises from "node:timers/promises";
import {
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  WsRpcGroup,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";
import { applyShellStreamEvent } from "../../../packages/client-runtime/src/state/shellReducer.ts";
import type { EnvironmentObservation } from "./feed.ts";

export async function watchEnvironment(
  config: { url: string; tokenPath: string; environmentId: string },
  observation: EnvironmentObservation,
  signal: AbortSignal,
) {
  await reconnectEnvironment(
    async (connected) => {
      const headers = {
        authorization: `Bearer ${NodeFS.readFileSync(config.tokenPath, "utf8").trim()}`,
      };
      const descriptorResponse = await fetch(new URL("/.well-known/t3/environment", config.url), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!descriptorResponse.ok) throw new Error("Environment discovery failed");
      const descriptor = (await descriptorResponse.json()) as { environmentId: string };
      if (descriptor.environmentId !== config.environmentId)
        throw new Error("Environment identity changed");
      const environmentId = EnvironmentId.make(descriptor.environmentId);
      const ticketResponse = await fetch(new URL("/api/auth/websocket-ticket", config.url), {
        method: "POST",
        headers,
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!ticketResponse.ok)
        throw new Error(`Environment authorization failed: ${ticketResponse.status}`);
      const ticket = (await ticketResponse.json()) as { ticket: string };
      const socketUrl = new URL("/ws", config.url);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      socketUrl.searchParams.set("wsTicket", ticket.ticket);
      const program = Effect.gen(function* () {
        const disconnected = yield* Deferred.make<void>();
        const socketLayer = Socket.layerWebSocket(socketUrl.toString(), {
          openTimeout: "10 seconds",
        }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
        const protocol = Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              socketLayer,
              RpcSerialization.layerJson,
              Layer.succeed(RpcClient.ConnectionHooks, {
                onConnect: Effect.void,
                onDisconnect: Deferred.succeed(disconnected, undefined),
              }),
            ),
          ),
        );
        const context = yield* Layer.build(protocol);
        const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(context));
        let snapshot: OrchestrationShellSnapshot | null = null;
        const subscription = client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
          Stream.runForEach((item) =>
            Effect.sync(() => {
              if (item.kind === "synchronized") return;
              snapshot =
                item.kind === "snapshot"
                  ? item.snapshot
                  : snapshot
                    ? applyShellStreamEvent(snapshot, item)
                    : null;
              if (!snapshot) return;
              observation.snapshot = snapshot;
              observation.onSnapshot?.(snapshot, item.kind === "snapshot");
              if (!observation.connected)
                console.info("Activity environment connected", { environmentId });
              observation.connected = true;
              connected();
            }),
          ),
        );
        yield* Effect.raceFirst(subscription, Deferred.await(disconnected));
      }).pipe(Effect.scoped);
      await Effect.runPromise(program, { signal });
    },
    signal,
    () => {
      observation.connected = false;
      observation.onDisconnect?.();
    },
    (delayMs) =>
      console.warn("Activity environment disconnected; retry scheduled", {
        environmentId: config.environmentId,
        delayMs,
      }),
  );
}

/** A brief reconnect must not reset the backoff of a flapping server. */
export async function reconnectEnvironment(
  connect: (connected: () => void) => Promise<void>,
  signal: AbortSignal,
  disconnected: () => void,
  retrying: (delayMs: number) => void,
) {
  let delayMs = 5_000;
  while (!signal.aborted) {
    let connectedAt: number | undefined;
    try {
      await connect(() => {
        connectedAt ??= NodePerfHooks.performance.now();
      });
    } catch {
      // Both failed attempts and clean socket closures use the same retry policy.
    } finally {
      disconnected();
    }
    if (signal.aborted) return;
    if (connectedAt !== undefined && NodePerfHooks.performance.now() - connectedAt >= 60_000)
      delayMs = 5_000;
    retrying(delayMs);
    await NodeTimersPromises.setTimeout(delayMs, undefined, { signal }).catch(() => {});
    delayMs = Math.min(delayMs * 2, 45_000);
  }
}
