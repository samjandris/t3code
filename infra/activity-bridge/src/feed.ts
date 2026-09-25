// @effect-diagnostics globalDate:off - Timestamp disconnected activity rows.
import { EnvironmentId, type OrchestrationShellSnapshot } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import * as Schema from "effect/Schema";
import { makeAggregateState } from "../../relay/src/agentActivity/agentActivityAggregate.ts";
import type { ActivityBridge } from "./bridge.ts";
import type { NotificationBridge } from "./notifications.ts";

const Credentials = Schema.Record(
  Schema.String,
  Schema.Struct({ tokenPath: Schema.String, url: Schema.optional(Schema.String) }),
);
export const decodeCredentials = Schema.decodeUnknownSync(Credentials);
export interface EnvironmentObservation {
  connected: boolean;
  snapshot: OrchestrationShellSnapshot | null;
  onSnapshot?: (snapshot: OrchestrationShellSnapshot, replay: boolean) => void;
  onDisconnect?: () => void;
}
interface Source extends EnvironmentObservation {
  environmentId: string;
  label: string;
  url: string;
  tokenPath: string;
  controller: AbortController;
  projectedSnapshot?: OrchestrationShellSnapshot;
  states?: RelayAgentActivityState[];
}
type Watch = (
  config: { url: string; tokenPath: string; environmentId: string },
  observation: EnvironmentObservation,
  signal: AbortSignal,
) => Promise<void>;

export class ActivityFeed {
  private sources = new Map<string, Source>();
  private linked: ReadonlyArray<RelayClientEnvironmentRecord> = [];
  private discoveredAt = -Infinity;
  private readonly bridge: ActivityBridge;
  private readonly watch: Watch;
  private readonly notifications: NotificationBridge | undefined;
  constructor(bridge: ActivityBridge, watch: Watch, notifications?: NotificationBridge) {
    this.bridge = bridge;
    this.watch = watch;
    this.notifications = notifications;
  }

  reconcile(
    environments: ReadonlyArray<RelayClientEnvironmentRecord>,
    credentials: typeof Credentials.Type,
    now: number,
  ) {
    this.linked = environments;
    this.discoveredAt = now;
    const wanted = new Set(environments.map((environment) => String(environment.environmentId)));
    for (const [id, source] of this.sources) {
      const credential = credentials[id];
      const environment = environments.find((item) => item.environmentId === id);
      const url = credential?.url ?? environment?.endpoint?.httpBaseUrl;
      if (
        !wanted.has(id) ||
        !credential ||
        credential.tokenPath !== source.tokenPath ||
        url !== source.url
      ) {
        source.controller.abort();
        this.notifications?.forgetEnvironment(id);
        this.sources.delete(id);
      }
    }
    for (const environment of environments) {
      const id = environment.environmentId;
      const credential = credentials[id];
      const url = credential?.url ?? environment.endpoint?.httpBaseUrl;
      if (!credential || !url || this.sources.has(id)) continue;
      const source: Source = {
        environmentId: id,
        label: environment.label,
        url,
        tokenPath: credential.tokenPath,
        connected: false,
        snapshot: null,
        controller: new AbortController(),
        onSnapshot: (snapshot, replay) => {
          if (this.sources.get(id) === source)
            this.notifications?.observe(id, projectStates(source, snapshot), replay, Date.now());
        },
        onDisconnect: () => {
          if (this.sources.get(id) === source) this.notifications?.forgetEnvironment(id);
        },
      };
      this.sources.set(id, source);
      void this.watch(source, source, source.controller.signal);
    }
    this.refresh(now);
  }

  status() {
    return this.linked.map((environment) => {
      const source = this.sources.get(environment.environmentId);
      return {
        environmentId: environment.environmentId,
        label: environment.label,
        status: !source
          ? "authorization_required"
          : source.connected
            ? "connected"
            : "disconnected",
      };
    });
  }

  refresh(now: number) {
    const states: RelayAgentActivityState[] = [];
    for (const source of this.sources.values()) {
      if (!source.snapshot) continue;
      for (const state of projectStates(source, source.snapshot)) {
        // A sleeping box must not look completed or stop other boxes updating.
        states.push(
          !source.connected && state.phase !== "completed" && state.phase !== "failed"
            ? { ...state, phase: "stale", updatedAt: new Date(now).toISOString() }
            : state,
        );
      }
    }
    this.bridge.aggregate = makeAggregateState({
      activeStates: states,
      terminalState: null,
      nowMs: now,
    });
    // A failed discovery must not retain access to an unlinked box indefinitely.
    this.bridge.connected =
      now - this.discoveredAt < 90_000 &&
      [...this.sources.values()].some((source) => source.connected);
  }

  invalidateCredential(id: string) {
    const source = this.sources.get(id);
    source?.controller.abort();
    this.sources.delete(id);
    this.notifications?.forgetEnvironment(id);
  }

  dispose() {
    for (const source of this.sources.values()) source.controller.abort();
    this.sources.clear();
    this.bridge.connected = false;
  }
}

function activityStates(snapshot: OrchestrationShellSnapshot, environmentId: string) {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  return snapshot.threads.flatMap((thread) => {
    const project = projects.get(thread.projectId);
    if (!project || thread.archivedAt !== null) return [];
    const state = projectThreadAwareness({
      environmentId: EnvironmentId.make(environmentId),
      project,
      thread,
    });
    return state ? [state] : [];
  });
}

function projectStates(source: Source, snapshot: OrchestrationShellSnapshot) {
  if (source.projectedSnapshot !== snapshot) {
    source.states = activityStates(snapshot, source.environmentId);
    source.projectedSnapshot = snapshot;
  }
  return source.states!;
}
