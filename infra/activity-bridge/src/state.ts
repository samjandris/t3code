// @effect-diagnostics nodeBuiltinImport:off - Private helper state, separate from T3 userdata.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import {
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
} from "@t3tools/contracts/relay";

const PendingAlert = Schema.Struct({
  deviceId: Schema.String,
  token: Schema.optional(Schema.String),
  state: RelayAgentActivityState,
  expiresAt: Schema.Number,
});
const DeliveredActivity = Schema.Struct({
  token: Schema.String,
  content: Schema.String,
  at: Schema.Number,
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
});
const RuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  published: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.NullOr(RelayAgentActivityState)),
  ),
  notifications: Schema.Struct({
    baselines: Schema.Record(Schema.String, Schema.Array(RelayAgentActivityState)),
    pending: Schema.Record(Schema.String, PendingAlert),
  }),
  delivered: Schema.Record(Schema.String, DeliveredActivity),
});
export type RuntimeState = typeof RuntimeState.Type;
const decodeRuntimeState = Schema.decodeUnknownSync(RuntimeState);

/** Atomic, mode-0600 snapshots retain pending delivery across helper restarts. */
export function runtimeStateFile(path: string) {
  let previous: string | undefined;
  return {
    read(): RuntimeState | undefined {
      try {
        const raw = NodeFS.readFileSync(path, "utf8");
        const state = decodeRuntimeState(JSON.parse(raw));
        previous = JSON.stringify(state);
        return state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        // oxlint-disable-next-line preserve-caught-error -- Schema errors can contain device tokens.
        throw new Error("Unable to read activity delivery state; details withheld", {
          cause: error instanceof Error ? error.name : undefined,
        });
      }
    },
    write(state: RuntimeState) {
      const next = JSON.stringify(state);
      if (next === previous) return;
      NodeFS.writeFileSync(`${path}.tmp`, next, { mode: 0o600 });
      NodeFS.renameSync(`${path}.tmp`, path);
      previous = next;
    },
  };
}
