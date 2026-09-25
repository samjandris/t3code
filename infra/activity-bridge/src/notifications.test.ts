import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { ActivityBridge } from "./bridge.ts";
import { NotificationBridge } from "./notifications.ts";
import {
  activityRequest,
  notificationRequest,
  type Delivery,
  type DeliveryResult,
  type NotificationDelivery,
} from "./apns.ts";
import { makeAggregateState } from "../../relay/src/agentActivity/agentActivityAggregate.ts";

const now = Date.parse("2026-09-20T12:00:00Z");
const preferences: RelayAgentAwarenessPreferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const state = (
  phase: RelayAgentActivityState["phase"],
  environmentId = "box",
  threadId = "thread",
): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make(environmentId),
  threadId: ThreadId.make(threadId),
  projectTitle: "Project",
  threadTitle: "Thread",
  phase,
  headline: "Task",
  modelTitle: "Codex",
  updatedAt: "2026-09-20T12:00:00.000Z",
  deepLink: `/threads/${environmentId}/${threadId}`,
});
function fixture() {
  const sender = vi
    .fn<(delivery: NotificationDelivery) => Promise<DeliveryResult>>()
    .mockResolvedValue({ ok: true, status: 200 });
  const activitySender = vi
    .fn<(delivery: Delivery) => Promise<DeliveryResult>>()
    .mockResolvedValue({ ok: true, status: 200 });
  const bridge = new ActivityBridge(activitySender, () => {});
  bridge.register({
    deviceId: "phone",
    enabled: false,
    pushToken: "a".repeat(64),
    preferences,
    registeredAt: now,
  });
  bridge.connected = true;
  const notifications = new NotificationBridge(bridge, sender);
  const observe = (phase: RelayAgentActivityState["phase"], replay = false) => {
    notifications.observe("box", [state(phase)], replay, now);
    bridge.aggregate = makeAggregateState({
      activeStates: [state(phase)],
      terminalState: null,
      nowMs: now,
    });
  };
  const activate = () => {
    const device = bridge.devices.get("phone")!;
    bridge.register({
      ...device,
      enabled: true,
      preferences: { ...preferences, liveActivitiesEnabled: true },
    });
    bridge.registerActivity("phone", "c".repeat(64), now);
  };
  return { sender, activitySender, bridge, notifications, observe, activate };
}

describe("notification delivery", () => {
  it.each([
    [false, "waiting_for_input"],
    [false, "completed"],
    [true, "waiting_for_input"],
    [true, "completed"],
  ] as const)(
    "drops superseded %s-card %s alerts instead of retrying old details",
    async (card, phase) => {
      const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
      if (card) activate();
      const deliverySender = card ? activitySender : sender;
      deliverySender.mockResolvedValueOnce({ ok: false, status: 503 });
      observe("running", true);
      observe(phase);
      await notifications.flush(now);
      const latest = {
        ...state(phase),
        threadTitle: "Updated thread",
        updatedAt: "2026-09-20T12:00:01.000Z",
      };
      notifications.observe("box", [latest], false, now + 1_000);
      bridge.aggregate = makeAggregateState({
        activeStates: [latest],
        terminalState: null,
        nowMs: now + 1_000,
      });
      await notifications.flush(now + 5_000);
      expect(sender).toHaveBeenCalledTimes(card ? 0 : 1);
      expect(activitySender.mock.calls.filter(([delivery]) => delivery.alert)).toHaveLength(
        card ? 1 : 0,
      );
      if (card) {
        expect(activitySender.mock.lastCall?.[0].aggregate?.activities[0]?.threadTitle).toBe(
          "Updated thread",
        );
        expect(activitySender.mock.lastCall?.[0].alert).toBeUndefined();
      }
      // A subsequent real transition still alerts with the new state.
      observe("running");
      notifications.observe("box", [latest], false, now + 6_000);
      await notifications.flush(now + 10_000);
      expect(sender).toHaveBeenCalledTimes(card ? 0 : 2);
      expect(activitySender.mock.calls.filter(([delivery]) => delivery.alert)).toHaveLength(
        card ? 2 : 0,
      );
    },
  );

  it("alerts for a fresh completion even if the running event was not observed", async () => {
    const { sender, notifications } = fixture();
    notifications.observe("box", [], true, now);
    notifications.observe("box", [state("completed")], false, now);
    await notifications.flush(now);
    expect(sender).toHaveBeenCalledOnce();
  });
  it.each(["waiting_for_approval", "waiting_for_input", "completed", "failed"] as const)(
    "alerts on %s without a Live Activity",
    async (phase) => {
      const { sender, notifications, observe } = fixture();
      observe("running", true);
      observe(phase);
      await notifications.flush(now);
      expect(sender).toHaveBeenCalledOnce();
      expect(sender.mock.calls[0]?.[0].notification).toMatchObject({
        phase,
        environmentId: "box",
        threadId: "thread",
        deepLink: "/threads/box/thread",
      });
      observe(phase);
      await notifications.flush(now + 5_000);
      expect(sender).toHaveBeenCalledOnce();
    },
  );

  it("does not replay initial, reconnect, or old terminal states", async () => {
    const { sender, notifications, observe } = fixture();
    observe("completed");
    await notifications.flush(now);
    observe("running");
    observe("waiting_for_approval");
    notifications.forgetEnvironment("box");
    observe("waiting_for_approval", true);
    await notifications.flush(now);
    notifications.observe(
      "box",
      [{ ...state("completed", "box", "old-thread"), updatedAt: "2026-09-20T11:00:00.000Z" }],
      false,
      now,
    );
    await notifications.flush(now);
    expect(sender).not.toHaveBeenCalled();
  });

  it("treats attention and terminal phases as upstream transition groups", async () => {
    const { sender, notifications, observe } = fixture();
    observe("waiting_for_approval", true);
    observe("waiting_for_input");
    await notifications.flush(now);
    expect(sender).not.toHaveBeenCalled();
    observe("completed");
    await notifications.flush(now);
    observe("failed");
    await notifications.flush(now);
    expect(sender).toHaveBeenCalledOnce();
  });

  it.each([
    ["waiting_for_approval", "notifyOnApproval"],
    ["waiting_for_input", "notifyOnInput"],
    ["completed", "notifyOnCompletion"],
    ["failed", "notifyOnFailure"],
    ["completed", "notificationsEnabled"],
  ] as const)("honors %s preference %s", async (phase, flag) => {
    const { sender, bridge, notifications, observe } = fixture();
    bridge.devices.get("phone")!.preferences = { ...preferences, [flag]: false };
    observe("running", true);
    observe(phase);
    await notifications.flush(now);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not alert with a token but no recorded permission", async () => {
    const { sender, bridge, notifications, observe } = fixture();
    delete bridge.devices.get("phone")!.preferences;
    observe("running", true);
    observe("completed");
    await notifications.flush(now);
    expect(sender).not.toHaveBeenCalled();
  });

  it("keeps all threads and environments independently of the five-row card", async () => {
    const { sender, notifications } = fixture();
    for (const environment of ["one", "two"]) {
      notifications.observe(
        environment,
        Array.from({ length: 8 }, (_, i) => state("running", environment, String(i))),
        true,
        now,
      );
      notifications.observe(
        environment,
        Array.from({ length: 8 }, (_, i) => state("completed", environment, String(i))),
        false,
        now,
      );
    }
    await notifications.flush(now);
    expect(sender).toHaveBeenCalledTimes(16);
    expect(
      new Set(
        sender.mock.calls.map(
          ([job]) => `${job.notification.environmentId}/${job.notification.threadId}`,
        ),
      ).size,
    ).toBe(16);
  });

  it("retries attention for ten minutes and only fresh completions", async () => {
    const { sender, notifications, observe } = fixture();
    sender.mockResolvedValueOnce({ ok: false, status: 503 });
    observe("running", true);
    observe("completed");
    await notifications.flush(now);
    await notifications.flush(now + 5_000);
    expect(sender).toHaveBeenCalledTimes(2);
    observe("running");
    observe("waiting_for_input");
    await notifications.flush(now + 600_000);
    expect(sender).toHaveBeenCalledTimes(2);
    observe("running");
    notifications.observe(
      "box",
      [{ ...state("completed"), updatedAt: "2026-09-20T11:57:59.999Z" }],
      false,
      now,
    );
    await notifications.flush(now);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it.each(["signout", "permission", "rotation", "removed", "changed", "replay"])(
    "cancels queued work after %s",
    async (change) => {
      const { sender, bridge, notifications, observe } = fixture();
      observe("running", true);
      observe("waiting_for_input");
      bridge.connected = false;
      await notifications.flush(now);
      expect(sender).not.toHaveBeenCalled();
      switch (change) {
        case "signout":
          bridge.disable("phone");
          break;
        case "permission":
          bridge.devices.get("phone")!.preferences = {
            ...preferences,
            notificationsEnabled: false,
          };
          break;
        case "rotation":
          bridge.devices.get("phone")!.pushToken = "b".repeat(64);
          break;
        case "removed":
          notifications.observe("box", [], false, now);
          break;
        case "changed":
          observe("running");
          break;
        case "replay":
          observe("waiting_for_input", true);
          break;
      }
      bridge.connected = true;
      await notifications.flush(now + 5_000);
      expect(sender).not.toHaveBeenCalled();
    },
  );

  it("retires an invalid notification token without removing the Live Activity", async () => {
    const { sender, bridge, notifications, observe, activate } = fixture();
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<DeliveryResult>();
    sender.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    observe("running", true);
    observe("completed");
    const flushing = notifications.flush(now);
    await started.promise;
    activate();
    result.resolve({ ok: false, status: 410, reason: "Unregistered" });
    await flushing;
    await notifications.flush(now + 5_000);
    expect(sender).toHaveBeenCalledOnce();
    expect(bridge.devices.get("phone")?.pushToken).toBeUndefined();
    expect(bridge.devices.get("phone")?.token).toBe("c".repeat(64));
  });

  it("does not remove a rotated token when an old request fails", async () => {
    const { sender, bridge, notifications, observe } = fixture();
    let finish!: (result: DeliveryResult) => void;
    const started = Promise.withResolvers<void>();
    sender.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
          started.resolve();
        }),
    );
    observe("running", true);
    observe("completed");
    const flushing = notifications.flush(now);
    await started.promise;
    bridge.devices.get("phone")!.pushToken = "b".repeat(64);
    finish({ ok: false, status: 410 });
    await flushing;
    expect(bridge.devices.get("phone")?.pushToken).toBe("b".repeat(64));
  });

  it("builds an expiring alert with upstream text and navigation data", async () => {
    const { sender, notifications, observe } = fixture();
    observe("running", true);
    observe("completed");
    await notifications.flush(now);
    const delivery = sender.mock.calls[0]![0];
    const request = notificationRequest(delivery, "com.samjandris.t3code.preview");
    expect(request.headers).toMatchObject({
      "apns-push-type": "alert",
      "apns-topic": "com.samjandris.t3code.preview",
      "apns-expiration": String((now + 120_000) / 1000),
    });
    expect(request.headers["apns-collapse-id"]).toHaveLength(64);
    expect(notificationRequest(delivery, "com.samjandris.t3code.preview")).toEqual(request);
    expect(request.payload).toEqual({
      aps: { alert: { title: "Thread", body: "Done: Project" }, sound: "default" },
      body: {
        environmentId: "box",
        threadId: "thread",
        deepLink: "/threads/box/thread",
      },
    });
  });
});

describe("Live Activity alert selection", () => {
  it.each([
    ["waiting_for_approval", "waiting_for_input", "Input: Project"],
    ["completed", "failed", "Failed: Project"],
  ] as const)(
    "keeps an undelivered %s alert when its group changes to %s",
    async (first, next, body) => {
      const { sender, activitySender, notifications, observe, activate } = fixture();
      activate();
      observe("running", true);
      observe(first);
      observe(next);
      await notifications.flush(now);
      await notifications.flush(now + 5_000);
      expect(activitySender).toHaveBeenCalledOnce();
      expect(activitySender.mock.calls[0]?.[0].alert?.body).toBe(body);
      expect(sender).not.toHaveBeenCalled();
    },
  );

  it("does not repeat an in-flight alert when approval becomes input", async () => {
    const { sender, activitySender, notifications, observe, activate } = fixture();
    activate();
    observe("running", true);
    observe("waiting_for_approval");
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<DeliveryResult>();
    activitySender.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const flushing = notifications.flush(now);
    await started.promise;
    observe("waiting_for_input");
    result.resolve({ ok: true, status: 200 });
    await flushing;
    await notifications.flush(now + 5_000);
    expect(activitySender.mock.calls.filter(([delivery]) => delivery.alert)).toHaveLength(1);
    expect(sender).not.toHaveBeenCalled();
  });
  it.each(["waiting_for_approval", "waiting_for_input", "completed", "failed"] as const)(
    "delivers %s through the card without a separate notification",
    async (phase) => {
      const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
      activate();
      observe("running", true);
      await notifications.flush(now);
      expect(activitySender.mock.calls[0]?.[0].alert).toBeUndefined();
      observe(phase);
      // Alerts bypass routine update throttling, even within the same second.
      await notifications.flush(now);
      expect(activitySender.mock.calls[1]?.[0]).toMatchObject({
        event: "update",
        token: "c".repeat(64),
        alert: { title: "Thread" },
      });
      expect(bridge.devices.get("phone")?.token).toBe("c".repeat(64));
      expect(sender).not.toHaveBeenCalled();
      observe(phase);
      await notifications.flush(now + 5_000);
      expect(activitySender).toHaveBeenCalledTimes(2);
      const request = activityRequest(
        activitySender.mock.calls[1]![0],
        "com.samjandris.t3code.preview",
        now,
      );
      expect(request.headers).toMatchObject({
        "apns-push-type": "liveactivity",
        "apns-topic": "com.samjandris.t3code.preview.push-type.liveactivity",
        "apns-priority": "10",
      });
      expect(request.payload.aps.alert).toMatchObject({ title: "Thread", sound: "default" });
      expect(request.payload.aps["content-state"]).toBeDefined();
      expect(
        activityRequest(activitySender.mock.calls[0]![0], "app", now).headers["apns-priority"],
      ).toBe("5");
    },
  );

  it.each([
    ["waiting_for_approval", "notifyOnApproval"],
    ["waiting_for_input", "notifyOnInput"],
    ["completed", "notifyOnCompletion"],
    ["failed", "notifyOnFailure"],
    ["completed", "notificationsEnabled"],
  ] as const)("silently updates the card when %s is muted by %s", async (phase, flag) => {
    const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
    activate();
    observe("running", true);
    observe(phase);
    bridge.devices.get("phone")!.preferences = {
      ...preferences,
      liveActivitiesEnabled: true,
      [flag]: false,
    };
    await notifications.flush(now);
    expect(activitySender).toHaveBeenCalledOnce();
    expect(activitySender.mock.calls[0]?.[0].alert).toBeUndefined();
    expect(sender).not.toHaveBeenCalled();
  });

  it("alerts through the card without an ordinary push token", async () => {
    const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
    activate();
    delete bridge.devices.get("phone")!.pushToken;
    observe("running", true);
    observe("completed");
    await notifications.flush(now);
    expect(activitySender.mock.calls[0]?.[0].alert).toMatchObject({ body: "Done: Project" });
    expect(sender).not.toHaveBeenCalled();
  });

  it("groups simultaneous completions from all boxes into one activity alert", async () => {
    const { sender, activitySender, bridge, notifications, activate } = fixture();
    activate();
    const completed: RelayAgentActivityState[] = [];
    for (const environment of ["one", "two"]) {
      const rows = Array.from({ length: 8 }, (_, i) => state("completed", environment, String(i)));
      completed.push(...rows);
      notifications.observe(
        environment,
        rows.map((row) => ({ ...row, phase: "running" })),
        true,
        now,
      );
      notifications.observe(environment, rows, false, now);
    }
    bridge.aggregate = makeAggregateState({
      activeStates: completed,
      terminalState: null,
      nowMs: now,
    });
    expect(bridge.aggregate?.activities).toHaveLength(5);
    await notifications.flush(now);
    await notifications.flush(now + 5_000);
    expect(activitySender).toHaveBeenCalledOnce();
    expect(activitySender.mock.calls[0]?.[0].alert?.title).toBe("16 agents finished");
    expect(activitySender.mock.calls[0]![0].alert!.body.length).toBeLessThanOrEqual(120);
    expect(sender).not.toHaveBeenCalled();
  });

  it("groups attention first and retains concurrent completions for the next update", async () => {
    const { sender, activitySender, bridge, notifications, activate } = fixture();
    activate();
    notifications.observe("box", [state("running"), state("running", "box", "other")], true, now);
    const rows = [state("waiting_for_approval"), state("completed", "box", "other")];
    notifications.observe("box", rows, false, now);
    bridge.aggregate = makeAggregateState({ activeStates: rows, terminalState: null, nowMs: now });
    await notifications.flush(now);
    await notifications.flush(now + 5_000);
    await notifications.flush(now + 10_000);
    expect(activitySender.mock.calls.map(([delivery]) => delivery.alert?.body)).toEqual([
      "Approval: Project",
      "Done: Project",
    ]);
    expect(sender).not.toHaveBeenCalled();
  });

  it.each(["no card", "disabled", "expired"])(
    "uses an ordinary notification with %s",
    async (condition) => {
      const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
      if (condition !== "no card") activate();
      observe("running", true);
      observe("completed");
      if (condition === "disabled") bridge.devices.get("phone")!.enabled = false;
      if (condition === "expired")
        bridge.devices.get("phone")!.registeredAt = now - 8 * 60 * 60_000 - 1;
      await notifications.flush(now);
      expect(sender).toHaveBeenCalledOnce();
      expect(activitySender.mock.calls.every(([delivery]) => !delivery.alert)).toBe(true);
    },
  );

  it.each(["server failure", "transport failure"])(
    "retries an activity %s without sending a standalone alert",
    async (failure) => {
      const { sender, activitySender, notifications, observe, activate } = fixture();
      activate();
      observe("running", true);
      observe("completed");
      if (failure === "server failure")
        activitySender.mockResolvedValueOnce({ ok: false, status: 503 });
      else activitySender.mockRejectedValueOnce(new Error("APNs unavailable"));
      await notifications.flush(now);
      expect(sender).not.toHaveBeenCalled();
      await notifications.flush(now + 5_000);
      await notifications.flush(now + 10_000);
      expect(activitySender).toHaveBeenCalledTimes(2);
      expect(activitySender.mock.calls.every(([delivery]) => delivery.alert)).toBe(true);
      expect(sender).not.toHaveBeenCalled();
    },
  );

  it.each(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"])(
    "falls back when APNs rejects the card with %s",
    async (reason) => {
      const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
      activate();
      observe("running", true);
      observe("completed");
      activitySender.mockResolvedValueOnce({ ok: false, status: 400, reason });
      await notifications.flush(now);
      await notifications.flush(now + 5_000);
      expect(activitySender).toHaveBeenCalledOnce();
      expect(sender).toHaveBeenCalledOnce();
      expect(bridge.devices.get("phone")?.token).toBeUndefined();
      expect(bridge.devices.get("phone")?.pushToken).toBe("a".repeat(64));
    },
  );

  it("keeps replay and reconnect updates silent", async () => {
    const { sender, activitySender, notifications, observe, activate } = fixture();
    activate();
    observe("waiting_for_approval", true);
    await notifications.flush(now);
    observe("completed");
    notifications.forgetEnvironment("box");
    observe("completed", true);
    await notifications.flush(now + 5_000);
    expect(activitySender.mock.calls.every(([delivery]) => !delivery.alert)).toBe(true);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not race a second flush or lose new transitions during delivery", async () => {
    const { sender, activitySender, notifications, observe, activate } = fixture();
    activate();
    observe("running", true);
    observe("waiting_for_approval");
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<DeliveryResult>();
    activitySender.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const flushing = notifications.flush(now);
    await started.promise;
    observe("completed");
    await notifications.flush(now + 1_000);
    expect(activitySender).toHaveBeenCalledOnce();
    result.resolve({ ok: true, status: 200 });
    await flushing;
    await notifications.flush(now + 5_000);
    expect(activitySender.mock.calls.map(([delivery]) => delivery.alert?.body)).toEqual([
      "Approval: Project",
      "Done: Project",
    ]);
    expect(sender).not.toHaveBeenCalled();
  });

  it("does not re-alert after a successful push while registration changes", async () => {
    const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
    activate();
    observe("running", true);
    observe("completed");
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<DeliveryResult>();
    activitySender.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const flushing = notifications.flush(now);
    await started.promise;
    bridge.register({ ...bridge.devices.get("phone")!, registeredAt: now + 1_000 });
    result.resolve({ ok: true, status: 200 });
    await flushing;
    await notifications.flush(now + 5_000);
    expect(activitySender.mock.calls.filter(([delivery]) => delivery.alert)).toHaveLength(1);
    expect(sender).not.toHaveBeenCalled();
  });

  it("retries on a rotated activity token without retiring the replacement", async () => {
    const { sender, activitySender, bridge, notifications, observe, activate } = fixture();
    activate();
    observe("running", true);
    observe("completed");
    const started = Promise.withResolvers<void>();
    const result = Promise.withResolvers<DeliveryResult>();
    activitySender.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    const flushing = notifications.flush(now);
    await started.promise;
    bridge.registerActivity("phone", "d".repeat(64), now + 1_000);
    result.resolve({ ok: false, status: 410 });
    await flushing;
    await notifications.flush(now + 5_000);
    expect(activitySender.mock.calls[1]?.[0]).toMatchObject({
      token: "d".repeat(64),
      alert: { body: "Done: Project" },
    });
    expect(sender).not.toHaveBeenCalled();
  });

  it("drops stale completion alerts while still refreshing the card", async () => {
    const { sender, activitySender, notifications, observe, activate } = fixture();
    activate();
    observe("running", true);
    observe("completed");
    activitySender.mockResolvedValueOnce({ ok: false, status: 503 });
    await notifications.flush(now);
    await notifications.flush(now + 120_000);
    expect(activitySender.mock.calls[1]?.[0].alert).toBeUndefined();
    expect(sender).not.toHaveBeenCalled();
  });
});
