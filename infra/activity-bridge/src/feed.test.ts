import { describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import { ActivityBridge } from "./bridge.ts";
import { ActivityFeed, type EnvironmentObservation } from "./feed.ts";
import { NotificationBridge } from "./notifications.ts";
const stubProject = {
  id: ProjectId.make("project-1"),
  title: "Test Project",
  workspaceRoot: "/workspace/test",
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
} as const;

const stubThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-09-20T00:00:00.000Z",
  updatedAt: "2026-09-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  pullRequests: [],
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  session: null,
} as const;

const now = Date.parse("2026-09-20T00:00:00.000Z");
const environment = (id: string) => ({
  environmentId: EnvironmentId.make(id),
  label: id,
  endpoint: {
    httpBaseUrl: `https://${id}.example.test`,
    wsBaseUrl: `wss://${id}.example.test/ws`,
    providerKind: "cloudflare_tunnel" as const,
  },
  linkedAt: stubProject.createdAt,
});
const credentials = { one: { tokenPath: "/one" }, two: { tokenPath: "/two" } };
function snapshot(active = true, count = 1): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 0,
    updatedAt: stubProject.updatedAt,
    projects: [stubProject],
    threads: Array.from({ length: count }, (_, i) => ({
      ...stubThread,
      id: ThreadId.make(`thread-${i}`),
      hasPendingApprovals: active,
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
  const feed = new ActivityFeed(bridge, watch, notifications);
  const connect = (id: string, active = true, count = 1) => {
    const observation = observations.get(id)!;
    observation.state.snapshot = snapshot(active, count);
    observation.state.connected = true;
  };
  return { feed, bridge, watch, observations, connect, sender, notifications };
}
describe("discovered activity environments", () => {
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
    feed.refresh(now);
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
  const first = state.snapshot!;
  const projectRead = vi.fn(() => [stubProject]);
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
