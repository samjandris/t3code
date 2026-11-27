// @effect-diagnostics nodeBuiltinImport:off - Native Node helper runtime.
// @effect-diagnostics globalDate:off - Native Node helper runtime.
import type * as NodeHttp from "node:http";
import * as Schema from "effect/Schema";
import {
  RelayDeviceRegistrationRequest,
  RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import type { ActivityBridge } from "./bridge.ts";

const decodeDevice = Schema.decodeUnknownSync(RelayDeviceRegistrationRequest);
const decodeActivity = Schema.decodeUnknownSync(RelayLiveActivityRegistrationRequest);

export function createHandler(
  config: {
    login: string;
    bundleId: string;
    environment: "sandbox" | "production";
    pushReady: boolean;
  },
  bridge: ActivityBridge,
  refreshSnapshot: () => void = () => {},
  environments: () => unknown = () => [],
) {
  return async (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify(body));
    };
    // Only trust Serve's identity header on a loopback listener. Serve strips
    // caller-supplied identity headers before injecting the authenticated user.
    if (request.headers["tailscale-user-login"] !== config.login)
      return reply(403, { error: "Connect through the authorized Tailscale account" });
    const path = request.url?.split("?")[0];
    if (request.method === "GET" && path === "/health")
      return reply(200, {
        pushReady: config.pushReady,
        environmentConnected: bridge.connected,
        environments: environments(),
        devices: bridge.devices.size,
        notificationDevices: [...bridge.devices.values()].filter((device) => device.pushToken)
          .length,
      });
    if (!config.pushReady)
      return reply(503, { error: "Apple push credentials are not configured" });
    try {
      if (request.method === "GET" && path === "/v1/mobile/agent-activity") {
        refreshSnapshot();
        return bridge.connected
          ? reply(200, { aggregate: bridge.aggregate })
          : reply(503, { error: "T3 Connect activity feed unavailable" });
      }
      if (request.method === "DELETE" && path?.startsWith("/v1/mobile/devices/")) {
        bridge.disable(decodeURIComponent(path.slice("/v1/mobile/devices/".length)));
        return reply(200, { ok: true });
      }
      if (
        request.method !== "POST" ||
        (path !== "/v1/mobile/devices" && path !== "/v1/mobile/live-activities")
      )
        return reply(404, { error: "Not found" });
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 16_384) return reply(413, { error: "Request too large" });
      }
      const body: unknown = JSON.parse(raw);
      if (path === "/v1/mobile/devices") {
        const registration = decodeDevice(body);
        if (
          registration.platform !== "ios" ||
          registration.bundleId !== config.bundleId ||
          registration.apsEnvironment !== config.environment
        )
          return reply(400, { error: "App identity does not match this helper" });
        if (!bridge.devices.has(registration.deviceId) && bridge.devices.size >= 8)
          return reply(409, { error: "Device limit reached" });
        if (registration.pushToken && !/^[a-f\d]{32,512}$/i.test(registration.pushToken))
          return reply(400, { error: "Invalid notification token" });
        bridge.register({
          deviceId: registration.deviceId,
          enabled: registration.preferences.liveActivitiesEnabled,
          preferences: registration.preferences,
          ...(registration.preferences.notificationsEnabled && registration.pushToken
            ? { pushToken: registration.pushToken }
            : {}),
          registeredAt: Date.now(),
        });
      } else {
        const registration = decodeActivity(body);
        if (!/^[a-f\d]{32,512}$/i.test(registration.activityPushToken))
          return reply(400, { error: "Invalid activity token" });
        bridge.registerActivity(registration.deviceId, registration.activityPushToken, Date.now());
      }
      return reply(200, { ok: true });
    } catch {
      return reply(400, { error: "Invalid registration" });
    }
  };
}
