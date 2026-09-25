import * as NodePerfHooks from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { reconnectEnvironment } from "./watcher.ts";

const { sleep } = vi.hoisted(() => ({ sleep: vi.fn() }));
vi.mock("node:timers/promises", () => ({ setTimeout: sleep }));

afterEach(() => {
  sleep.mockReset();
  vi.restoreAllMocks();
});

function controlledSleeps() {
  type Wait = { delay: number; resume: () => void };
  const queued: Wait[] = [];
  let receive: ((wait: Wait) => void) | undefined;
  sleep.mockImplementation(
    (delay: number, _value: undefined, { signal }: { signal: AbortSignal }) =>
      new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        const wait = {
          delay,
          resume: () => {
            signal.removeEventListener("abort", abort);
            resolve();
          },
        };
        if (receive) {
          const deliver = receive;
          receive = undefined;
          deliver(wait);
        } else queued.push(wait);
      }),
  );
  return () => {
    const wait = queued.shift();
    return wait ? Promise.resolve(wait) : new Promise<Wait>((resolve) => (receive = resolve));
  };
}

describe("environment reconnects", () => {
  it("backs off repeated failures to 45 seconds and stops during the wait when cancelled", async () => {
    const nextWait = controlledSleeps();
    const controller = new AbortController();
    const connect = vi.fn(async () => {
      throw new Error("Server offline");
    });
    const disconnected = vi.fn();
    const retrying = vi.fn();
    const running = reconnectEnvironment(connect, controller.signal, disconnected, retrying);
    for (const [index, delay] of [5_000, 10_000, 20_000, 40_000, 45_000, 45_000].entries()) {
      const wait = await nextWait();
      expect(wait.delay).toBe(delay);
      expect(retrying).toHaveBeenLastCalledWith(delay);
      expect(connect).toHaveBeenCalledTimes(index + 1);
      if (index < 5) wait.resume();
    }
    controller.abort();
    await running;
    expect(connect).toHaveBeenCalledTimes(6);
    expect(disconnected).toHaveBeenCalledTimes(6);
  });

  it.each([
    [59_999, 10_000],
    [60_000, 5_000],
  ])("after a %i ms connection the next delay is %i ms", async (connectedFor, expectedDelay) => {
    const nextWait = controlledSleeps();
    const controller = new AbortController();
    let now = 100_000;
    vi.spyOn(NodePerfHooks.performance, "now").mockImplementation(() => now);
    let attempts = 0;
    const running = reconnectEnvironment(
      async (connected) => {
        if (++attempts === 1) throw new Error("Server offline");
        connected();
        now += connectedFor;
        // Repeated snapshots must not restart the stable-connection clock.
        connected();
      },
      controller.signal,
      vi.fn(),
      vi.fn(),
    );
    const first = await nextWait();
    expect(first.delay).toBe(5_000);
    first.resume();
    expect((await nextWait()).delay).toBe(expectedDelay);
    controller.abort();
    await running;
  });

  it("cancels an actual Node timer without waiting for its retry deadline", async () => {
    const timers =
      await vi.importActual<typeof import("node:timers/promises")>("node:timers/promises");
    sleep.mockImplementation(timers.setTimeout);
    const controller = new AbortController();
    const scheduled = Promise.withResolvers<void>();
    const connect = vi.fn(async () => {});
    const running = reconnectEnvironment(connect, controller.signal, vi.fn(), () =>
      scheduled.resolve(),
    );
    await scheduled.promise;
    controller.abort();
    await running;
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("does not schedule another attempt when aborted during a connection", async () => {
    const controller = new AbortController();
    const disconnected = vi.fn();
    const retrying = vi.fn();
    await reconnectEnvironment(
      async () => controller.abort(),
      controller.signal,
      disconnected,
      retrying,
    );
    expect(disconnected).toHaveBeenCalledOnce();
    expect(retrying).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not start an already cancelled watcher", async () => {
    const controller = new AbortController();
    controller.abort();
    const connect = vi.fn();
    await reconnectEnvironment(connect, controller.signal, vi.fn(), vi.fn());
    expect(connect).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});
