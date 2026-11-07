import type { RelayAgentActivityState } from "@t3tools/contracts/relay";

/** Matches AgentAwarenessRelay's identity: shell timestamps alone are not activity. */
export function activityIdentity(state: RelayAgentActivityState | null) {
  if (!state) return "null";
  const { updatedAt: _updatedAt, ...meaningful } = state;
  return JSON.stringify(meaningful);
}

/** Confirm tombstones and live completions before exposing them to delivery. */
export class ActivityPublication {
  readonly states = new Map<string, RelayAgentActivityState | null>();
  private confirmations = new Map<string, number>();
  private heldCompletions = new Set<string>();

  update(
    states: ReadonlyArray<RelayAgentActivityState>,
    replay: boolean,
    now: number,
    readSettledCompletion?: (threadId: string) => RelayAgentActivityState | null,
  ) {
    const next = new Map<string, RelayAgentActivityState>(
      states.map((state) => [state.threadId, state]),
    );
    let changed = false;
    for (const id of new Set([
      ...this.states.keys(),
      ...next.keys(),
      ...this.confirmations.keys(),
    ])) {
      const state = next.get(id) ?? null;
      if (
        this.states.has(id) &&
        activityIdentity(this.states.get(id)!) === activityIdentity(state)
      ) {
        this.confirmations.delete(id);
        this.heldCompletions.delete(id);
        continue;
      }
      // Replays seed silently; live completions wait for possible continuations.
      if (state === null || (state.phase === "completed" && !replay)) {
        if (state?.phase === "completed") this.heldCompletions.add(id);
        const deadline = this.confirmations.get(id);
        if (deadline === undefined) {
          this.confirmations.set(id, now + 5_000);
          continue;
        }
        if (now < deadline) continue;
        if (state === null && this.heldCompletions.has(id)) {
          const completion = readSettledCompletion?.(id);
          if (completion?.phase === "completed") {
            this.states.set(id, completion);
            this.heldCompletions.delete(id);
            this.confirmations.set(id, now + 5_000);
            changed = true;
            continue;
          }
        }
      }
      this.confirmations.delete(id);
      this.heldCompletions.delete(id);
      if (state === null) this.states.delete(id);
      else this.states.set(id, state);
      changed = true;
    }
    return changed;
  }

  rows() {
    return [...this.states.values()].filter((state) => state !== null);
  }
}
