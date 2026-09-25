import { describe, expect, it, vi } from "vite-plus/test";
import type { RelayAgentActivityAggregateState } from "@t3tools/contracts/relay";
import { ActivityBridge } from "./bridge.ts";
import { activityPayload, type Delivery, type DeliveryResult } from "./apns.ts";

const working: RelayAgentActivityAggregateState = {
  title: "T3 Code",
  subtitle: "Agent work in progress",
  activeCount: 1,
  updatedAt: "2026-09-20T00:00:00.000Z",
  activities: [],
};
function fixture(
  sender = vi
    .fn<(delivery: Delivery) => Promise<DeliveryResult>>()
    .mockResolvedValue({ ok: true, status: 200 }),
) {
  const bridge = new ActivityBridge(sender, () => {});
  bridge.register({ deviceId: "phone", enabled: true, registeredAt: 0 });
  bridge.registerActivity("phone", "a".repeat(64), 0);
  bridge.connected = true;
  bridge.aggregate = working;
  return { bridge, sender };
}

describe("activity push helper", () => {
  it("keeps notification registration after a Live Activity expires", async () => {
    const { bridge } = fixture();
    bridge.devices.get("phone")!.pushToken = "b".repeat(64);
    await bridge.flush(8 * 60 * 60_000 + 1);
    expect(bridge.devices.get("phone")?.token).toBeUndefined();
    expect(bridge.devices.get("phone")?.pushToken).toBe("b".repeat(64));
  });
  it("does not publish stale snapshots while disconnected", async () => {
    const { bridge, sender } = fixture();
    bridge.connected = false;
    await bridge.flush(20_000);
    expect(sender).not.toHaveBeenCalled();
    bridge.connected = true;
    await bridge.flush(25_000);
    expect(sender).toHaveBeenCalledOnce();
  });

  it("delivers timestamp-only changes after the routine throttle and suppresses identical state", async () => {
    const { bridge, sender } = fixture();
    await bridge.flush(20_000);
    bridge.aggregate = { ...working, updatedAt: "2026-09-20T00:00:05.000Z" };
    await bridge.flush(25_000);
    expect(sender).toHaveBeenCalledOnce();
    await bridge.flush(35_000);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.lastCall?.[0].aggregate?.updatedAt).toBe("2026-09-20T00:00:05.000Z");
    await bridge.flush(335_000);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("waits for a just-started turn instead of immediately ending its local card", async () => {
    const { bridge, sender } = fixture();
    bridge.aggregate = null;
    await bridge.flush(5_000);
    expect(sender).not.toHaveBeenCalled();
    bridge.aggregate = working;
    await bridge.flush(10_000);
    expect(sender.mock.calls[0]?.[0].event).toBe("update");
  });

  it("keeps completed content on the card and ends when it expires", async () => {
    const { bridge, sender } = fixture();
    bridge.aggregate = { ...working, activeCount: 0 };
    await bridge.flush(20_000);
    expect(sender.mock.calls[0]?.[0].event).toBe("update");
    expect(bridge.devices.get("phone")?.token).toBe("a".repeat(64));
    bridge.aggregate = null;
    await bridge.flush(25_000);
    expect(sender.mock.calls[1]?.[0].event).toBe("end");
    expect(bridge.devices.get("phone")?.token).toBeUndefined();
  });

  it("ends disabled activities even if the environment disconnected", async () => {
    const { bridge, sender } = fixture();
    bridge.connected = false;
    bridge.disable("phone");
    await bridge.flush(5_000);
    expect(sender.mock.calls[0]?.[0].event).toBe("end");
  });

  it("retries transient APNs failures without recording delivery", async () => {
    const { bridge, sender } = fixture();
    sender.mockResolvedValueOnce({ ok: false, status: 503 });
    await bridge.flush(20_000);
    await bridge.flush(25_000);
    expect(sender).toHaveBeenCalledTimes(2);
  });

  it("retires invalid tokens without retrying forever", async () => {
    const { bridge, sender } = fixture();
    sender.mockResolvedValueOnce({ ok: false, status: 410, reason: "Unregistered" });
    await bridge.flush(20_000);
    await bridge.flush(25_000);
    expect(sender).toHaveBeenCalledOnce();
  });

  it("does not remove a rotated token when an old delivery finishes", async () => {
    let finish!: (result: DeliveryResult) => void;
    const sender = vi.fn<(delivery: Delivery) => Promise<DeliveryResult>>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const { bridge } = fixture(sender);
    const pending = bridge.flush(20_000);
    bridge.registerActivity("phone", "b".repeat(64), 21_000);
    finish({ ok: false, status: 410 });
    await pending;
    expect(bridge.devices.get("phone")?.token).toBe("b".repeat(64));
  });

  it("uses the existing Expo widget payload and includes a final state on end", () => {
    const payload = activityPayload({ token: "unused", event: "end", aggregate: working }, 20_000);
    expect(payload.aps).toMatchObject({
      timestamp: 20,
      event: "end",
      "dismissal-date": 320,
      "content-state": { name: "AgentActivity", props: JSON.stringify(working) },
    });
    expect(
      activityPayload({ token: "unused", event: "end", aggregate: null }, 20_000).aps,
    ).toMatchObject({ "dismissal-date": 35 });
  });

  it("gives a newly armed empty card upstream's two-minute grace", async () => {
    const { bridge, sender } = fixture();
    bridge.aggregate = null;
    await bridge.flush(119_999);
    expect(sender).not.toHaveBeenCalled();
    await bridge.flush(120_000);
    expect(sender.mock.calls[0]?.[0].event).toBe("end");
  });

  it("replays the current card on foreground registration without extending its lifetime", async () => {
    const { bridge, sender } = fixture();
    await bridge.flush(20_000);
    bridge.register({ deviceId: "phone", enabled: true, registeredAt: 21_000 });
    bridge.registerActivity("phone", "a".repeat(64), 21_000);
    await bridge.flush(25_000);
    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.lastCall?.[0]).toMatchObject({ event: "update", aggregate: working });
    expect(sender.mock.lastCall?.[0].alert).toBeUndefined();
    expect(bridge.devices.get("phone")?.registeredAt).toBe(0);
    await bridge.flush(8 * 60 * 60_000 + 1);
    expect(bridge.devices.get("phone")?.token).toBeUndefined();
  });

  it.each(["device", "activity"] as const)(
    "does not let an in-flight push suppress a newer %s registration replay",
    async (registration) => {
      let finish!: (result: DeliveryResult) => void;
      const sender = vi
        .fn<(delivery: Delivery) => Promise<DeliveryResult>>()
        .mockResolvedValue({ ok: true, status: 200 });
      const { bridge } = fixture(sender);
      sender.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = bridge.flush(20_000);
      if (registration === "device") {
        bridge.register({ deviceId: "phone", enabled: true, registeredAt: 21_000 });
      } else {
        bridge.registerActivity("phone", "a".repeat(64), 21_000);
      }
      finish({ ok: true, status: 200 });
      await pending;
      await bridge.flush(25_000);
      expect(sender).toHaveBeenCalledTimes(2);
      expect(bridge.devices.get("phone")?.registeredAt).toBe(0);
      await bridge.flush(30_000);
      expect(sender).toHaveBeenCalledTimes(2);
    },
  );

  it("updates a reused card through work, completion, and more work without a new thread", async () => {
    const { bridge, sender } = fixture();
    await bridge.flush(20_000);
    bridge.aggregate = { ...working, activeCount: 0, subtitle: "Agent work completed" };
    await bridge.flush(25_000);
    bridge.aggregate = working;
    await bridge.flush(30_000);
    expect(sender.mock.calls.map(([delivery]) => delivery.aggregate?.activeCount)).toEqual([
      1, 0, 1,
    ]);
    expect(sender.mock.calls.every(([delivery]) => delivery.event === "update")).toBe(true);
  });

  it("throttles routine redraws for fifteen seconds but promptly changes counts", async () => {
    const { bridge, sender } = fixture();
    await bridge.flush(20_000);
    bridge.aggregate = { ...working, subtitle: "Changed model" };
    await bridge.flush(25_000);
    expect(sender).toHaveBeenCalledOnce();
    await bridge.flush(35_000);
    expect(sender).toHaveBeenCalledTimes(2);
    bridge.aggregate = { ...working, activeCount: 2 };
    await bridge.flush(36_000);
    expect(sender).toHaveBeenCalledTimes(3);
  });
});
