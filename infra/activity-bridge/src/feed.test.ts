import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import {
  v2Now,
  v2Project,
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { ActivityBridge } from "./bridge.ts";
import { ActivityFeed, type EnvironmentObservation } from "./feed.ts";
import { NotificationBridge } from "./notifications.ts";
import { applyEnvironmentShellItem } from "./watcher.ts";
const timestamp = "2026-09-20T00:00:00.000Z";
const now = Date.parse(timestamp);
const environment = (id: string) => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  endpoint: {
    httpBaseUrl: `https://${id}.example.test`,
    wsBaseUrl: `wss://${id}.example.test/ws`,
    providerKind: "cloudflare_tunnel" as const,
  },
  linkedAt: "2026-09-20T00:00:00.000Z",
});
const credentials = { one: { tokenPath: "/one" }, two: { tokenPath: "/two" } };
function snapshot(active = true, count = 1) {
  return {
    ...v2ShellSnapshot,
    threads: Array.from({ length: count }, (_, i) => ({
      ...v2ThreadShell,
      id: ThreadId.make(`thread-${i}`),
      updatedAt: DateTime.makeUnsafe(now),
      pendingRuntimeRequest: active
        ? {
            id: RuntimeRequestId.make(`request-${i}`),
            kind: "permission" as const,
            createdAt: v2Now,
          }
        : null,
    })),
  };
}
function fixture() {
  const sender = vi.fn().mockResolvedValue({ ok: true, status: 200 });
  const bridge = new ActivityBridge(sender, () => {});
  const notifications = new NotificationBridge(bridge, sender);
  const observations = new Map<string, { state: EnvironmentObservation; signal: AbortSignal }>();
  const watch = vi.fn(
    async (
      config: { environmentId: string },
      state: EnvironmentObservation,
      signal: AbortSignal,
    ) => {
      observations.set(config.environmentId, { state, signal });
    },
  );
  const feed = new ActivityFeed(
    bridge,
    watch,
    notifications,
    () => {},
    () => now,
  );
  const connect = (id: string, active = true, count = 1) => {
    const observation = observations.get(id)!;
    const replay = observation.state.snapshot === null;
    observation.state.snapshot = snapshot(active, count);
    observation.state.connected = true;
    observation.state.onSnapshot?.(observation.state.snapshot, replay);
  };
  return { feed, bridge, watch, observations, connect, sender, notifications };
}
describe("discovered activity environments", () => {
  it("preserves a pending alert across a project enrichment snapshot", async () => {
    const { feed, bridge, connect, observations, notifications, sender } = fixture();
    bridge.register({
      deviceId: "phone",
      enabled: true,
      registeredAt: now,
      preferences: {
        liveActivitiesEnabled: true,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    bridge.registerActivity("phone", "a".repeat(64), now);
    feed.reconcile([environment("one")], credentials, now);
    connect("one", false);
    connect("one");
    applyEnvironmentShellItem(observations.get("one")!.state, {
      kind: "snapshot",
      snapshot: { ...v2ShellSnapshot, threads: [], archivedThreads: [] },
      resolvedRepositoryIdentityRoots: [],
    });
    feed.refresh(now);
    await notifications.flush(now);
    expect(sender).toHaveBeenCalledOnce();
    expect(sender.mock.lastCall?.[0].alert).toBeDefined();
  });

  it("keeps an armed card through a brief disappearance", async () => {
    const { feed, bridge, connect, sender } = fixture();
    feed.reconcile([environment("one")], credentials, now);
    bridge.register({ deviceId: "phone", enabled: true, registeredAt: now });
    bridge.registerActivity("phone", "a".repeat(64), now);
    connect("one");
    feed.refresh(now);
    await bridge.flush(now);
    connect("one", false);
    feed.refresh(now + 1_000);
    await bridge.flush(now + 1_000);
    connect("one");
    feed.refresh(now + 2_000);
    await bridge.flush(now + 2_000);
    expect(sender.mock.calls.map(([delivery]) => delivery.event)).toEqual(["update"]);
    expect(bridge.activityToken("phone", now + 2_000)).toBe("a".repeat(64));
  });

  it.each(["running", "waiting_for_approval"] as const)(
    "expires disconnected %s using its original publication time",
    (phase) => {
      const { feed, bridge, connect, observations } = fixture();
      feed.reconcile([environment("one"), environment("two")], credentials, now);
      connect("one", phase === "waiting_for_approval");
      const source = observations.get("one")!.state;
      if (phase === "running") {
        source.snapshot = {
          ...snapshot(false),
          threads: [{ ...snapshot(false).threads[0]!, status: "running" }],
        };
        source.onSnapshot!(source.snapshot, false);
      }
      connect("two");
      source.connected = false;
      source.onDisconnect?.();
      feed.refresh(now + 5_000);
      const first = bridge.aggregate;
      feed.refresh(now + 10_000);
      expect(bridge.aggregate).toEqual(first);
      const ttl = (phase === "running" ? 2 : 24) * 60 * 60_000;
      const later = now + ttl + 1;
      const live = observations.get("two")!.state;
      live.snapshot = {
        ...snapshot(),
        threads: [
          {
            ...snapshot().threads[0]!,
            title: "Still working",
            updatedAt: DateTime.makeUnsafe(later),
          },
        ],
      };
      live.onSnapshot!(live.snapshot, false);
      feed.reconcile([environment("one"), environment("two")], credentials, later);
      expect(bridge.aggregate?.activities.map((row) => row.environmentId)).toEqual(["two"]);
      expect(bridge.aggregate?.activeCount).toBe(1);
    },
  );

  it("honors a server's publishing switch and silently reseeds when enabled again", async () => {
    const { feed, bridge, connect, observations, notifications, sender } = fixture();
    bridge.register({
      deviceId: "phone",
      enabled: false,
      registeredAt: now,
      pushToken: "a".repeat(64),
      preferences: {
        liveActivitiesEnabled: false,
        notificationsEnabled: true,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    feed.reconcile([environment("one")], credentials, now);
    connect("one", false);
    connect("one");
    const source = observations.get("one")!.state;
    source.publishingEnabled = false;
    feed.refresh(now);
    await notifications.flush(now);
    expect(bridge.aggregate).toBeNull();
    expect(sender).not.toHaveBeenCalled();
    source.publishingEnabled = true;
    feed.refresh(now + 5_000);
    await notifications.flush(now + 5_000);
    expect(bridge.aggregate?.activeCount).toBe(1);
    expect(sender).not.toHaveBeenCalled();
  });

  it("observes alerts before display limiting and ignores callbacks from a replaced connection", async () => {
    const { feed, bridge, observations, connect, sender, notifications } = fixture();
    bridge.register({
      deviceId: "phone",
      enabled: false,
      registeredAt: now,
      pushToken: "a".repeat(64),
      preferences: {
        notificationsEnabled: true,
        liveActivitiesEnabled: false,
        notifyOnApproval: true,
        notifyOnInput: true,
        notifyOnCompletion: true,
        notifyOnFailure: true,
      },
    });
    feed.reconcile([environment("one")], credentials, now);
    const old = observations.get("one")!.state;
    old.onSnapshot?.(snapshot(false, 8), true);
    feed.reconcile([environment("one")], { one: { tokenPath: "/replacement" } }, now);
    const current = observations.get("one")!.state;
    connect("one", false, 8);
    current.onSnapshot?.(snapshot(false, 8), true);
    old.onDisconnect?.();
    old.onSnapshot?.(snapshot(true, 8), false);
    await notifications.flush(now);
    expect(sender).not.toHaveBeenCalled();
    current.onSnapshot?.(snapshot(true, 8), false);
    feed.refresh(now);
    await notifications.flush(now);
    expect(sender).toHaveBeenCalledTimes(8);
    feed.dispose();
  });
  it("discovers new boxes, waits for authorization, and stops removed or changed endpoints", () => {
    const { feed, watch, observations } = fixture();
    feed.reconcile([environment("one")], credentials, now);
    feed.reconcile([environment("one"), environment("two")], { one: credentials.one }, now);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(feed.status()[1]?.status).toBe("authorization_required");
    feed.reconcile([environment("one"), environment("two")], credentials, now);
    expect(watch).toHaveBeenCalledTimes(2);
    const old = observations.get("one")!;
    feed.reconcile([environment("two")], credentials, now);
    expect(old.signal.aborted).toBe(true);
    const oldTwo = observations.get("two")!;
    feed.reconcile(
      [
        {
          ...environment("two"),
          endpoint: { ...environment("two").endpoint, httpBaseUrl: "https://moved.example.test" },
        },
      ],
      credentials,
      now,
    );
    expect(oldTwo.signal.aborted).toBe(true);
    expect(watch).toHaveBeenCalledTimes(3);
    feed.dispose();
    expect(observations.get("two")!.signal.aborted).toBe(true);
  });
  it("combines boxes before limiting display rows and preserves identical thread IDs across boxes", () => {
    const { feed, bridge, connect } = fixture();
    feed.reconcile([environment("one"), environment("two")], credentials, now);
    connect("one");
    connect("two");
    feed.refresh(now);
    expect(bridge.aggregate?.activities.map((row) => row.environmentId)).toEqual(["one", "two"]);
    connect("two", true, 10);
    feed.refresh(now);
    expect(bridge.aggregate?.activeCount).toBe(11);
    expect(bridge.aggregate!.activities.length).toBeLessThan(11);
  });
  it("keeps the card alive when one box finishes and ends only when both finish", async () => {
    const { feed, bridge, connect, sender } = fixture();
    feed.reconcile([environment("one"), environment("two")], credentials, now);
    bridge.register({ deviceId: "phone", enabled: true, registeredAt: now - 20000 });
    bridge.registerActivity("phone", "a".repeat(64), now - 20000);
    connect("one", false);
    connect("two");
    feed.refresh(now);
    await bridge.flush(now);
    expect(sender.mock.calls[0]?.[0].event).toBe("update");
    connect("two", false);
    feed.refresh(now + 5000);
    await bridge.flush(now + 5000);
    expect(sender.mock.calls[1]?.[0].event).toBe("end");
  });
  it("marks disconnected work waiting while other boxes keep updating, then recovers", () => {
    const { feed, bridge, connect, observations } = fixture();
    feed.reconcile([environment("one"), environment("two")], credentials, now);
    connect("one");
    connect("two");
    observations.get("one")!.state.connected = false;
    feed.refresh(now);
    expect(bridge.connected).toBe(true);
    expect(bridge.aggregate?.activeCount).toBe(2);
    expect(bridge.aggregate?.activities.find((row) => row.environmentId === "one")?.phase).toBe(
      "stale",
    );
    connect("one", false);
    feed.refresh(now + 5_000);
    expect(bridge.aggregate?.activeCount).toBe(1);
    observations.get("one")!.state.connected = false;
    observations.get("two")!.state.connected = false;
    feed.refresh(now);
    expect(bridge.connected).toBe(false);
  });
  it("drops unlinked boxes and pauses delivery when account discovery is stale", () => {
    const { feed, bridge, connect } = fixture();
    feed.reconcile([environment("one"), environment("two")], credentials, now);
    connect("one");
    connect("two");
    feed.refresh(now);
    feed.reconcile([environment("two")], credentials, now);
    expect(bridge.aggregate?.activeCount).toBe(1);
    feed.refresh(now + 90001);
    expect(bridge.connected).toBe(false);
    feed.reconcile([environment("two")], credentials, now + 90002);
    expect(bridge.connected).toBe(true);
  });
});

it("projects an unchanged snapshot once while still recomputing connection state", () => {
  const { feed, bridge, observations, connect } = fixture();
  feed.reconcile([environment("one")], credentials, now);
  connect("one");
  const state = observations.get("one")!.state;
  const first = snapshot();
  state.snapshot = first;
  const projectRead = vi.fn(() => [v2Project]);
  Object.defineProperty(first, "projects", { get: projectRead });
  state.onSnapshot!(first, true);
  feed.refresh(now);
  feed.refresh(now + 5_000);
  expect(projectRead).toHaveBeenCalledTimes(1);
  state.connected = false;
  feed.refresh(now + 10_000);
  expect(bridge.connected).toBe(false);
  expect(projectRead).toHaveBeenCalledTimes(1);
  const second = snapshot();
  Object.defineProperty(second, "projects", { get: projectRead });
  state.snapshot = second;
  state.onSnapshot!(second, false);
  feed.refresh(now + 15_000);
  expect(projectRead).toHaveBeenCalledTimes(2);
  feed.invalidateCredential("one");
  expect(observations.get("one")!.signal.aborted).toBe(true);
});

it("combines activity across servers without completing monitored work", () => {
  const { feed, bridge, observations, connect } = fixture();
  feed.reconcile([environment("one"), environment("two")], credentials, now);
  connect("one");
  const state = observations.get("two")!.state;
  state.connected = true;
  state.protocolVersion = 2;
  state.snapshot = {
    ...v2ShellSnapshot,
    threads: [
      {
        ...v2ThreadShell,
        updatedAt: DateTime.makeUnsafe(timestamp),
        status: "completed",
        pendingBackgroundTasks: [{ taskId: "monitor", kind: "monitor" }],
      },
    ],
  };
  feed.refresh(now);
  expect(bridge.aggregate?.activeCount).toBe(2);
  expect(bridge.aggregate?.activities.find((row) => row.environmentId === "two")).toMatchObject({
    phase: "running",
    updatedAt: timestamp,
  });
  expect(feed.status()[1]).toMatchObject({ protocolVersion: 2, status: "connected" });
  state.snapshot = {
    ...state.snapshot,
    threads: [{ ...state.snapshot.threads[0]!, pendingBackgroundTasks: [] }],
  };
  feed.refresh(now);
  expect(bridge.aggregate?.activeCount).toBe(1);
});

it("omits V2 archived, deleted, and subagent threads and sends new attention once", async () => {
  const { feed, observations, notifications, bridge, sender } = fixture();
  bridge.register({
    deviceId: "phone",
    enabled: false,
    registeredAt: now,
    pushToken: "a".repeat(64),
    preferences: {
      notificationsEnabled: true,
      liveActivitiesEnabled: false,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
  });
  feed.reconcile([environment("one")], credentials, now);
  const state = observations.get("one")!.state;
  const pendingRuntimeRequest = {
    id: RuntimeRequestId.make("request"),
    kind: "user_input" as const,
    createdAt: v2Now,
  };
  const thread = {
    ...v2ThreadShell,
    updatedAt: DateTime.makeUnsafe(timestamp),
    status: "running" as const,
  };
  const first = { ...v2ShellSnapshot, threads: [thread] };
  state.onSnapshot!(first, true);
  const next = {
    ...first,
    threads: [
      { ...thread, pendingRuntimeRequest },
      { ...thread, id: ThreadId.make("archived"), archivedAt: v2Now, pendingRuntimeRequest },
      { ...thread, id: ThreadId.make("deleted"), deletedAt: v2Now, pendingRuntimeRequest },
      {
        ...thread,
        id: ThreadId.make("child"),
        lineage: {
          rootThreadId: thread.id,
          parentThreadId: thread.id,
          relationshipToParent: "subagent" as const,
        },
        pendingRuntimeRequest,
      },
    ],
  };
  state.connected = true;
  state.snapshot = next;
  state.onSnapshot!(next, false);
  feed.refresh(now);
  await notifications.flush(now);
  expect(bridge.aggregate?.activeCount).toBe(1);
  expect(sender).toHaveBeenCalledTimes(1);
  state.onSnapshot!(next, false);
  await notifications.flush(now);
  expect(sender).toHaveBeenCalledTimes(1);
});
