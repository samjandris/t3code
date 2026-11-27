import { fetch } from "expo/fetch";
import { Platform } from "react-native";
import * as Schema from "effect/Schema";
import { RelayAgentActivitySnapshotResponse } from "@t3tools/contracts/relay";

// Fork-only, opt-in transport. Tailscale Serve authenticates registration;
// Apple credentials and the helper's T3 Connect session stay on its host.
export const activityBridgeUrl =
  Platform.OS === "ios"
    ? process.env.EXPO_PUBLIC_T3CODE_ACTIVITY_BRIDGE_URL?.trim().replace(/\/$/, "")
    : undefined;

export async function activityBridgeRequest(
  path: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
) {
  if (!activityBridgeUrl || !activityBridgeUrl.startsWith("https://"))
    throw new Error("Activity helper requires HTTPS");
  const response = await fetch(`${activityBridgeUrl}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(
      `Activity helper returned ${response.status}. Check Tailscale and helper status.`,
    );
  return response.json() as Promise<unknown>;
}

const decodeSnapshot = Schema.decodeUnknownSync(RelayAgentActivitySnapshotResponse);

export async function readActivityBridgeSnapshot() {
  return decodeSnapshot(await activityBridgeRequest("/v1/mobile/agent-activity", "GET"));
}
