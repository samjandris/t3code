// @effect-diagnostics globalDate:off - Helper publication deadlines.
import { EnvironmentId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import type {
  RelayClientEnvironmentRecord,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Schema from "effect/Schema";
import { makeAggregateState } from "../../relay/src/agentActivity/agentActivityAggregate.ts";
import type { ActivityBridge } from "./bridge.ts";
import type { NotificationBridge } from "./notifications.ts";
import { isExpiredAgentActivityState } from "../../relay/src/agentActivity/agentActivityPayloads.ts";
import { ActivityPublication } from "./publication.ts";
import type { RuntimeState } from "./state.ts";

const Credentials = Schema.Record(
  Schema.String,
  Schema.Struct({ tokenPath: Schema.String, url: Schema.optional(Schema.String) }),
);
export const decodeCredentials = Schema.decodeUnknownSync(Credentials);
export interface EnvironmentObservation {
  connected: boolean;
  protocolVersion?: 2;
  publishingEnabled?: boolean;
  snapshot: OrchestrationV2ShellSnapshot | null;
  onSnapshot?: (snapshot: OrchestrationV2ShellSnapshot, replay: boolean) => void;
  onDisconnect?: () => void;
}
interface Source extends EnvironmentObservation {
  environmentId: string;
  label: string;
  url: string;
  tokenPath: string;
  controller: AbortController;
  projectedSnapshot?: OrchestrationV2ShellSnapshot;
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
  private readonly persist: () => void;
  private readonly now: () => number;
  private publications = new Map<string, ActivityPublication>();
  constructor(
    bridge: ActivityBridge,
    watch: Watch,
    notifications?: NotificationBridge,
    persist = () => {},
    now = Date.now,
  ) {
    this.bridge = bridge;
    this.watch = watch;
    this.notifications = notifications;
    this.persist = persist;
    this.now = now;
  }

  save(): RuntimeState["published"] {
    return Object.fromEntries(
      [...this.publications].map(([id, publication]) => [
        id,
        Object.fromEntries(publication.states),
      ]),
    );
  }

  restore(saved: RuntimeState["published"]) {
    for (const [id, states] of Object.entries(saved)) {
      const publication = new ActivityPublication();
      for (const [threadId, state] of Object.entries(states))
        publication.states.set(threadId, state);
      this.publications.set(id, publication);
    }
  }

  private forget(id: string) {
    this.publications.delete(id);
    this.notifications?.forgetEnvironment(id);
    this.persist();
  }

  private publish(source: Source, replay: boolean, now: number) {
    if (source.publishingEnabled === false) {
      if (this.publications.has(source.environmentId)) this.forget(source.environmentId);
      return;
    }
    if (!source.snapshot) return;
    let publication = this.publications.get(source.environmentId);
    if (!publication) {
      publication = new ActivityPublication();
      this.publications.set(source.environmentId, publication);
    }
    if (publication.update(projectStates(source, source.snapshot), replay, now) || replay) {
      this.notifications?.observe(source.environmentId, publication.rows(), replay, now);
      this.persist();
    }
  }

  reconcile(
    environments: ReadonlyArray<RelayClientEnvironmentRecord>,
    credentials: typeof Credentials.Type,
    now: number,
  ) {
    this.linked = environments;
    this.discoveredAt = now;
    const wanted = new Set(environments.map((environment) => String(environment.environmentId)));
    for (const id of this.publications.keys()) {
      if (!wanted.has(id) || !credentials[id]) this.forget(id);
    }
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
        this.notifications?.pauseEnvironment(id);
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
          if (this.sources.get(id) !== source) return;
          source.snapshot = snapshot;
          this.publish(source, replay, this.now());
        },
        onDisconnect: () => {
          if (this.sources.get(id) === source) this.notifications?.pauseEnvironment(id);
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
        protocolVersion: source?.protocolVersion,
        publishingEnabled: source?.publishingEnabled,
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
      if (source.connected || source.publishingEnabled === false) this.publish(source, false, now);
      for (const state of this.publications.get(source.environmentId)?.rows() ?? []) {
        // Expire using the last published phase and time, even while offline.
        if (isExpiredAgentActivityState(state, now)) continue;
        // A sleeping box must not look completed or stop other boxes updating.
        states.push(
          !source.connected && state.phase !== "completed" && state.phase !== "failed"
            ? { ...state, phase: "stale" }
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
    this.notifications?.pauseEnvironment(id);
  }

  dispose() {
    for (const source of this.sources.values()) source.controller.abort();
    this.sources.clear();
    this.bridge.connected = false;
  }
}

function activityStates(snapshot: OrchestrationV2ShellSnapshot, environmentId: string) {
  const projects = new Map(snapshot.projects.map((project) => [project.id, project]));
  const id = EnvironmentId.make(environmentId);
  return snapshot.threads.flatMap((thread) => {
    const project = projects.get(thread.projectId);
    if (!project || thread.archivedAt !== null || thread.deletedAt !== null) return [];
    const state = projectThreadAwarenessV2({ environmentId: id, project, thread });
    return state ? [state] : [];
  });
}

function projectStates(source: Source, snapshot: OrchestrationV2ShellSnapshot) {
  if (source.projectedSnapshot !== snapshot) {
    source.states = activityStates(snapshot, source.environmentId);
    source.projectedSnapshot = snapshot;
  }
  return source.states!;
}
