import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

/** Matches AgentAwarenessRelay's identity: shell timestamps alone are not activity. */
export function activityIdentity(state: RelayAgentActivityState | null) {
  if (!state) return "null";
  const { updatedAt: _updatedAt, ...meaningful } = state;
  return JSON.stringify(meaningful);
}

/** Confirm tombstones and first live completions before exposing them to delivery. */
export class ActivityPublication {
  readonly states = new Map<string, RelayAgentActivityState | null>();
  private confirmations = new Map<string, number>();

  update(states: ReadonlyArray<RelayAgentActivityState>, replay: boolean, now: number) {
    const next = new Map<string, RelayAgentActivityState>(
      states.map((state) => [state.threadId, state]),
    );
    let changed = false;
    for (const id of new Set([...this.states.keys(), ...next.keys()])) {
      const state = next.get(id) ?? null;
      if (
        this.states.has(id) &&
        activityIdentity(this.states.get(id)!) === activityIdentity(state)
      ) {
        this.confirmations.delete(id);
        continue;
      }
      // An authoritative replay seeds existing work silently. Only a newly
      // observed live completion can produce the thread-birth Done alert.
      if (state === null || (state.phase === "completed" && !this.states.has(id) && !replay)) {
        const deadline = this.confirmations.get(id);
        if (deadline === undefined) {
          this.confirmations.set(id, now + 5_000);
          continue;
        }
        if (now < deadline) continue;
      }
      this.confirmations.delete(id);
      this.states.set(id, state);
      changed = true;
    }
    return changed;
  }

  rows() {
    return [...this.states.values()].filter((state) => state !== null);
  }
}
