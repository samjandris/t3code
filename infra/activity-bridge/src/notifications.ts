// @effect-diagnostics globalConsole:off - Log only delivery status, never payloads or tokens.
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import {
  shouldAlertForActivity,
  alertForActivityRows,
  TERMINAL_NOTIFICATION_FRESHNESS_MS,
} from "../../relay/src/agentActivity/agentActivityAlerts.ts";
import {
  notificationForActivity,
  sanitizeApnsNotificationPayload,
} from "../../relay/src/agentActivity/agentActivityPayloads.ts";
import { statusForPhase } from "../../relay/src/agentActivity/agentActivityAggregate.ts";
import { expiresAtForJob } from "../../relay/src/agentActivity/apnsDeliveryJobs.ts";
import type { ActivityAlert, ActivityBridge } from "./bridge.ts";
import { isInvalidApnsToken, type DeliveryResult, type NotificationDelivery } from "./apns.ts";
import { activityIdentity } from "./publication.ts";
import type { RuntimeState } from "./state.ts";

type Phase = RelayAgentActivityState["phase"];
const attention = (phase: Phase | undefined) =>
  phase === "waiting_for_approval" || phase === "waiting_for_input";
const terminal = (phase: Phase | undefined) => phase === "completed" || phase === "failed";
interface Pending {
  deviceId: string;
  token: string | undefined;
  state: RelayAgentActivityState;
  expiresAt: number;
}

export class NotificationBridge {
  private readonly bridge: ActivityBridge;
  private readonly send: (delivery: NotificationDelivery) => Promise<DeliveryResult>;
  private readonly persist: () => void;
  private baselines = new Map<string, Map<string, RelayAgentActivityState>>();
  private pending = new Map<string, Pending>();
  private ready = new Set<string>();
  private flushing = false;

  constructor(
    bridge: ActivityBridge,
    send: (delivery: NotificationDelivery) => Promise<DeliveryResult>,
    persist = () => {},
  ) {
    this.bridge = bridge;
    this.send = send;
    this.persist = persist;
  }

  save(): RuntimeState["notifications"] {
    return {
      baselines: Object.fromEntries(
        [...this.baselines].map(([id, states]) => [id, [...states.values()]]),
      ),
      pending: Object.fromEntries(this.pending),
    };
  }

  restore(saved: RuntimeState["notifications"]) {
    this.baselines = new Map(
      Object.entries(saved.baselines).map(([id, states]) => [
        id,
        new Map(states.map((state) => [String(state.threadId), state])),
      ]),
    );
    this.pending = new Map(
      Object.entries(saved.pending).map(([key, job]) => [key, { ...job, token: job.token }]),
    );
    this.ready.clear();
  }

  pauseEnvironment(environmentId: string) {
    this.ready.delete(environmentId);
  }

  forgetEnvironment(environmentId: string) {
    this.baselines.delete(environmentId);
    this.ready.delete(environmentId);
    for (const [key, job] of this.pending) {
      if (job.state.environmentId === environmentId) this.pending.delete(key);
    }
    this.persist();
  }

  observe(
    environmentId: string,
    states: ReadonlyArray<RelayAgentActivityState>,
    replay: boolean,
    now: number,
  ) {
    const previous = this.baselines.get(environmentId);
    const next = new Map(
      states.map((state) => {
        const old = previous?.get(state.threadId);
        return [
          String(state.threadId),
          old && activityIdentity(old) === activityIdentity(state) ? old : state,
        ] as const;
      }),
    );
    this.baselines.set(environmentId, next);
    this.ready.add(environmentId);
    for (const [key, job] of this.pending) {
      if (job.state.environmentId !== environmentId) continue;
      const currentState = next.get(job.state.threadId);
      if (currentState?.phase === job.state.phase) continue;
      if (
        currentState &&
        ((attention(job.state.phase) && attention(currentState.phase)) ||
          (terminal(job.state.phase) && terminal(currentState.phase)))
      ) {
        // One undelivered transition, with the latest copy. Preserve its
        // identity so an in-flight success cannot cause a second buzz.
        job.state = currentState;
      } else this.pending.delete(key);
    }
    // Reconnects revalidate already queued work without creating historical alerts.
    if (replay || !previous) {
      this.persist();
      return;
    }
    for (const state of next.values()) {
      const old = previous.get(state.threadId)?.phase;
      if (
        old === state.phase ||
        (attention(old) && attention(state.phase)) ||
        (terminal(state.phase) && terminal(old))
      )
        continue;
      for (const device of this.bridge.devices.values()) {
        if (
          (!device.pushToken && !this.bridge.activityToken(device.deviceId, now)) ||
          !shouldAlertForActivity({
            phase: state.phase,
            updatedAt: state.updatedAt,
            preferences: device.preferences ?? null,
            nowMs: now,
          })
        )
          continue;
        this.pending.set(JSON.stringify([device.deviceId, environmentId, state.threadId]), {
          deviceId: device.deviceId,
          token: device.pushToken,
          state,
          expiresAt: Math.min(
            Date.parse(expiresAtForJob(now)),
            terminal(state.phase)
              ? Date.parse(state.updatedAt) + TERMINAL_NOTIFICATION_FRESHNESS_MS
              : Infinity,
          ),
        });
      }
    }
    this.persist();
  }

  private current(job: Pending, now: number) {
    const device = this.bridge.devices.get(job.deviceId);
    const state = this.baselines.get(job.state.environmentId)?.get(job.state.threadId);
    return Boolean(
      device &&
      // Match upstream's delivery-time identity check, including retries.
      state?.phase === job.state.phase &&
      state.updatedAt === job.state.updatedAt &&
      device.pushToken === job.token &&
      now < job.expiresAt &&
      shouldAlertForActivity({
        phase: job.state.phase,
        updatedAt: job.state.updatedAt,
        preferences: device.preferences ?? null,
        nowMs: now,
      }),
    );
  }

  private activityAlert(deviceId: string, now: number): ActivityAlert | null {
    const jobs = [...this.pending].filter(
      ([, job]) =>
        job.deviceId === deviceId &&
        this.ready.has(job.state.environmentId) &&
        this.current(job, now),
    );
    // Match upstream's attention-first grouping. Remaining completions can
    // alert on the next flush, including threads beyond the card's row limit.
    const attentionJobs = jobs.filter(([, job]) => attention(job.state.phase));
    const selected = attentionJobs.length ? attentionJobs : jobs;
    const rows = selected.map(([, job]) => ({
      ...job.state,
      status: statusForPhase(job.state.phase),
    }));
    const first = rows[0];
    const alert = alertForActivityRows(rows);
    if (!first || !alert) return null;
    const text = sanitizeApnsNotificationPayload({ ...notificationForActivity(first), ...alert });
    return {
      alert: { title: text.title, body: text.body },
      expiresAt: Math.min(...selected.map(([, job]) => job.expiresAt)),
      delivered: () => {
        for (const [key, job] of selected) {
          if (this.pending.get(key) === job) this.pending.delete(key);
        }
        this.persist();
      },
    };
  }

  async flush(now: number) {
    if (this.flushing) return;
    this.flushing = true;
    try {
      // One coordinated pass: the activity owns its alerts, even when its
      // delivery is deferred or retried. Fall back only without a usable card.
      await this.bridge.flush(now, (deviceId) => this.activityAlert(deviceId, now));
      for (const [key, job] of this.pending) {
        const device = this.bridge.devices.get(job.deviceId);
        if (!this.current(job, now)) {
          this.pending.delete(key);
          continue;
        }
        if (
          !this.bridge.connected ||
          !this.ready.has(job.state.environmentId) ||
          !device?.pushToken ||
          this.bridge.activityToken(job.deviceId, now)
        )
          continue;
        const token = device.pushToken;
        let result: DeliveryResult;
        try {
          result = await this.send({
            token,
            notification: notificationForActivity({
              ...job.state,
              status: statusForPhase(job.state.phase),
            }),
            expiresAt: job.expiresAt,
          });
        } catch {
          console.warn("Notification transport failed; will retry while fresh");
          continue;
        }
        console.info("Notification push", { status: result.status, reason: result.reason });
        if (this.pending.get(key) !== job) continue;
        if (result.ok) this.pending.delete(key);
        else if (isInvalidApnsToken(result)) {
          this.bridge.invalidatePushToken(job.deviceId, token);
          this.pending.delete(key);
        }
        this.persist();
      }
    } finally {
      this.flushing = false;
      this.persist();
    }
  }
}
