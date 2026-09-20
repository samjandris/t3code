// @effect-diagnostics nodeBuiltinImport:off - Exercise the helper's private on-disk state.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, RuntimeRequestId } from "@t3tools/contracts";
import {
  v2ShellSnapshot,
  v2ThreadShell,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { ActivityBridge, type RegisteredDevice } from "./bridge.ts";
import { ActivityFeed, type EnvironmentObservation } from "./feed.ts";
import { NotificationBridge } from "./notifications.ts";
import { runtimeStateFile, type RuntimeState } from "./state.ts";
import type { Delivery, DeliveryResult, NotificationDelivery } from "./apns.ts";

const now = Date.parse("2026-10-03T00:00:00Z");
const device: RegisteredDevice = {
  deviceId: "phone",
  enabled: true,
  token: "a".repeat(64),
  pushToken: "b".repeat(64),
  registeredAt: now,
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) NodeFS.rmSync(path, { recursive: true, force: true });
});

function fixture(saved?: RuntimeState, registration = device) {
  let observation: EnvironmentObservation | undefined;
  let time = now;
  const sender = vi
    .fn<(delivery: Delivery | NotificationDelivery) => Promise<DeliveryResult>>()
    .mockResolvedValue({ ok: true, status: 200 });
  const bridge = new ActivityBridge(sender, () => {});
  bridge.devices.set("phone", structuredClone(registration));
  const notifications = new NotificationBridge(bridge, sender);
  const feed = new ActivityFeed(
    bridge,
    async (_config, state) => {
      observation = state;
    },
    notifications,
    () => {},
    () => time,
  );
  if (saved) {
    bridge.restore(saved.delivered);
    notifications.restore(saved.notifications);
    feed.restore(saved.published);
  }
  feed.reconcile(
    [
      {
        environmentId: EnvironmentId.make("box"),
        label: "Box",
        linkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        endpoint: {
          httpBaseUrl: "https://box.example.test",
          wsBaseUrl: "wss://box.example.test/ws",
          providerKind: "cloudflare_tunnel",
        },
      },
    ],
    { box: { tokenPath: "/unused" } },
    now,
  );
  const observe = (
    phase: "running" | "waiting_for_approval" | "completed",
    at = now,
    replay = false,
  ) => {
    time = at;
    const snapshot = {
      ...v2ShellSnapshot,
      threads: [
        {
          ...v2ThreadShell,
          status: phase === "completed" ? ("completed" as const) : ("running" as const),
          updatedAt: DateTime.makeUnsafe(at),
          pendingRuntimeRequest:
            phase === "waiting_for_approval"
              ? {
                  id: RuntimeRequestId.make("request"),
                  kind: "permission" as const,
                  createdAt: DateTime.makeUnsafe(at),
                }
              : null,
        },
      ],
    };
    observation!.connected = true;
    observation!.onSnapshot!(snapshot, replay);
    feed.refresh(at);
  };
  const save = (): RuntimeState => ({
    version: 1,
    published: feed.save(),
    notifications: notifications.save(),
    delivered: bridge.save(),
  });
  return { sender, bridge, feed, notifications, observe, save };
}

describe("durable activity delivery", () => {
  it.each([false, true])(
    "resumes an unacknowledged alert after restart without repeating accepted delivery, card=%s",
    async (card) => {
      const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-activity-state-"));
      temporary.push(directory);
      const path = NodePath.join(directory, "delivery-state.json");
      const file = runtimeStateFile(path);
      expect(file.read()).toBeUndefined();
      const registration = structuredClone(device);
      if (!card) {
        registration.enabled = false;
        delete registration.token;
        registration.preferences = { ...registration.preferences!, liveActivitiesEnabled: false };
      }
      const first = fixture(undefined, registration);
      first.observe("running", now, true);
      first.observe("waiting_for_approval");
      first.sender.mockResolvedValueOnce({ ok: false, status: 503 });
      await first.notifications.flush(now);
      file.write(first.save());
      expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);

      const second = fixture(runtimeStateFile(path).read(), registration);
      await second.notifications.flush(now + 1_000);
      expect(second.sender).not.toHaveBeenCalled();
      second.observe("waiting_for_approval", now + 2_000, true);
      await second.notifications.flush(now + 2_000);
      expect(second.sender).toHaveBeenCalledOnce();
      expect(second.sender.mock.lastCall?.[0]).toHaveProperty(card ? "alert" : "notification");
      file.write(second.save());

      const third = fixture(runtimeStateFile(path).read(), registration);
      third.observe("waiting_for_approval", now + 3_000, true);
      await third.notifications.flush(now + 20_000);
      expect(third.sender).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "phase", "permission", "token", "unlinked"] as const)(
    "discards restored alerts after %s changes",
    async (change) => {
      const first = fixture();
      first.observe("running", now, true);
      first.observe("waiting_for_approval");
      const registration = structuredClone(device);
      if (change === "permission")
        registration.preferences = { ...registration.preferences!, notificationsEnabled: false };
      if (change === "token") registration.pushToken = "c".repeat(64);
      const second = fixture(
        JSON.parse(JSON.stringify(first.save())) as RuntimeState,
        registration,
      );
      second.observe(change === "phase" ? "running" : "waiting_for_approval", now + 1_000, true);
      if (change === "unlinked") second.feed.reconcile([], {}, now + 1_000);
      await second.notifications.flush(change === "expired" ? now + 600_001 : now + 2_000);
      expect(
        second.sender.mock.calls.filter(
          ([delivery]) => "notification" in delivery || delivery.alert,
        ),
      ).toHaveLength(0);
      expect(Object.keys(second.notifications.save().pending)).toHaveLength(0);
    },
  );

  it("does not replay a completion that arrived while the helper was stopped", async () => {
    const first = fixture();
    first.observe("running", now, true);
    await first.notifications.flush(now);
    const second = fixture(JSON.parse(JSON.stringify(first.save())) as RuntimeState);
    second.observe("completed", now + 1_000, true);
    await second.notifications.flush(now + 1_000);
    expect(second.sender).toHaveBeenCalledOnce();
    expect(second.sender.mock.lastCall?.[0]).toMatchObject({ aggregate: { activeCount: 0 } });
    expect(second.sender.mock.lastCall?.[0]).not.toHaveProperty("alert");
  });
});
