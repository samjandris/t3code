// @effect-diagnostics globalConsole:off - Native Node helper runtime.
import type {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";
import { isInvalidApnsToken, type Delivery, type DeliveryResult } from "./apns.ts";
import { newlyTerminalRows } from "../../relay/src/agentActivity/agentActivityAlerts.ts";

export interface ActivityAlert {
  alert: NonNullable<Delivery["alert"]>;
  expiresAt: number;
  delivered: () => void;
}

export interface RegisteredDevice {
  deviceId: string;
  enabled: boolean;
  token?: string;
  pushToken?: string;
  preferences?: RelayAgentAwarenessPreferences;
  registeredAt: number;
}

// One activity per device. Registration replaces its token; in-flight results
// for the old token must never delete or mark the replacement delivered.
export class ActivityBridge {
  readonly devices = new Map<string, RegisteredDevice>();
  private delivered = new Map<
    string,
    {
      content: string;
      at: number;
      aggregate: RelayAgentActivityAggregateState | null;
    }
  >();
  private flushing = false;
  aggregate: RelayAgentActivityAggregateState | null = null;
  connected = false;

  private readonly send: (delivery: Delivery) => Promise<DeliveryResult>;
  private readonly persist: () => void;

  constructor(send: (delivery: Delivery) => Promise<DeliveryResult>, persist: () => void) {
    this.send = send;
    this.persist = persist;
  }

  register(device: RegisteredDevice) {
    const previous = this.devices.get(device.deviceId);
    this.devices.set(device.deviceId, {
      ...device,
      ...(previous?.token ? { token: previous.token, registeredAt: previous.registeredAt } : {}),
    });
    // Match upstream registration replay. APNs acceptance does not prove the
    // phone rendered the last push; foreground registration repairs a stale card.
    this.delivered.delete(device.deviceId);
    this.persist();
  }

  registerActivity(deviceId: string, token: string, now: number) {
    const device = this.devices.get(deviceId);
    if (!device?.enabled) throw new Error("Register an enabled device first");
    this.devices.set(deviceId, {
      ...device,
      token,
      registeredAt: device.token === token ? device.registeredAt : now,
    });
    this.delivered.delete(deviceId);
    this.persist();
  }

  disable(deviceId: string) {
    const device = this.devices.get(deviceId);
    if (device) {
      delete device.pushToken;
      this.devices.set(deviceId, { ...device, enabled: false });
    }
    this.persist();
  }

  invalidatePushToken(deviceId: string, token: string) {
    const device = this.devices.get(deviceId);
    if (device?.pushToken !== token) return;
    delete device.pushToken;
    this.persist();
  }

  activityToken(deviceId: string, now: number) {
    const device = this.devices.get(deviceId);
    return device?.enabled && now - device.registeredAt <= 8 * 60 * 60_000
      ? (device.token ?? null)
      : null;
  }

  async flush(now: number, alertForDevice?: (deviceId: string) => ActivityAlert | null) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (const [id, device] of this.devices) {
        if (!device.token) continue;
        // ActivityKit activities have a bounded lifetime. Do not retain tokens forever.
        if (now - device.registeredAt > 8 * 60 * 60_000) {
          delete device.token;
          this.delivered.delete(id);
          this.persist();
          continue;
        }
        if (device.enabled && !this.connected) continue;
        const aggregate = device.enabled ? this.aggregate : null;
        // Keep upstream's recent Done/Failed rows on the same card until the
        // aggregate expires. Completion can then alert through that card too.
        const event = !aggregate ? "end" : "update";
        // A local card can arrive before the server acknowledges a new turn.
        if (
          device.enabled &&
          event === "end" &&
          !this.delivered.has(id) &&
          now - device.registeredAt < 120_000
        )
          continue;
        const content = `${event}:${JSON.stringify(aggregate)}`;
        const last = this.delivered.get(id);
        const alert = device.enabled && aggregate ? alertForDevice?.(id) : null;
        const urgent =
          aggregate &&
          (!last?.aggregate ||
            last.aggregate.activeCount !== aggregate.activeCount ||
            aggregate.activities.some(
              (row) => row.phase === "waiting_for_approval" || row.phase === "waiting_for_input",
            ) ||
            newlyTerminalRows(last.aggregate, aggregate, true).length > 0);
        if (!alert && event === "update" && !urgent && last && now - last.at < 15_000) continue;
        if (!alert && last?.content === content) continue;
        let result: DeliveryResult;
        try {
          result = await this.send({
            token: device.token,
            event,
            aggregate,
            ...(alert ? { alert: alert.alert, expiresAt: alert.expiresAt } : {}),
          });
        } catch {
          console.warn("Activity push transport failed; will retry");
          continue;
        }
        console.info("Activity push", {
          event,
          alert: Boolean(alert),
          activeCount: aggregate?.activeCount ?? 0,
          phases: aggregate?.activities.map((row) => row.phase) ?? [],
          status: result.status,
          reason: result.reason,
        });
        // A successful alert is consumed even if foreground registration
        // replaced the device record while APNs was responding.
        if (result.ok) alert?.delivered();
        if (this.devices.get(id) !== device) continue;
        if (result.ok) {
          this.delivered.set(id, { content, at: now, aggregate });
          if (event === "end") {
            delete device.token;
            this.persist();
          }
        } else if (isInvalidApnsToken(result)) {
          delete device.token;
          this.persist();
        }
      }
    } finally {
      this.flushing = false;
    }
  }
}
