import type {
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadActivity,
} from "@t3tools/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stripClientHeavyActivityPayload(payload: unknown): unknown {
  const payloadRecord = asRecord(payload);
  const dataRecord = asRecord(payloadRecord?.data);
  const itemRecord = asRecord(dataRecord?.item);
  if (!payloadRecord || !dataRecord || !itemRecord || !("aggregatedOutput" in itemRecord)) {
    return payload;
  }

  const { aggregatedOutput: _aggregatedOutput, ...itemWithoutAggregatedOutput } = itemRecord;
  return {
    ...payloadRecord,
    data: {
      ...dataRecord,
      item: itemWithoutAggregatedOutput,
    },
  };
}

export function sanitizeThreadActivityForClient(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = stripClientHeavyActivityPayload(activity.payload);
  return payload === activity.payload ? activity : { ...activity, payload };
}

export function sanitizeThreadForClient(thread: OrchestrationThread): OrchestrationThread {
  let changed = false;
  const activities = thread.activities.map((activity) => {
    const nextActivity = sanitizeThreadActivityForClient(activity);
    if (nextActivity !== activity) {
      changed = true;
    }
    return nextActivity;
  });

  return changed ? { ...thread, activities } : thread;
}

export function sanitizeOrchestrationEventForClient(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type !== "thread.activity-appended") {
    return event;
  }

  const activity = sanitizeThreadActivityForClient(event.payload.activity);
  return activity === event.payload.activity
    ? event
    : {
        ...event,
        payload: {
          ...event.payload,
          activity,
        },
      };
}
