// @effect-diagnostics nodeBuiltinImport:off - Exercise the real loopback HTTP boundary.
// @effect-diagnostics globalFetch:off - Exercise the real loopback HTTP boundary.
import * as NodeHttp from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { ActivityBridge } from "./bridge.ts";
import { createHandler } from "./http.ts";

const servers: ReturnType<typeof NodeHttp.createServer>[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function fixture(pushReady = true) {
  const bridge = new ActivityBridge(
    async () => ({ ok: true, status: 200 }),
    () => {},
  );
  const server = NodeHttp.createServer(
    createHandler(
      {
        login: "sam@example.test",
        bundleId: "com.samjandris.t3code.preview",
        environment: "sandbox",
        pushReady,
      },
      bridge,
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener");
  const request = (path: string, body?: unknown, login = "sam@example.test") =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "tailscale-user-login": login, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  return { request, bridge };
}
const device = {
  deviceId: "test-phone",
  platform: "ios",
  iosMajorVersion: 27,
  label: "Test iPhone",
  bundleId: "com.samjandris.t3code.preview",
  apsEnvironment: "sandbox",
  preferences: {
    liveActivitiesEnabled: true,
    notificationsEnabled: false,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("private registration API", () => {
  it("registers notifications independently and clears a revoked permission", async () => {
    const { request, bridge } = await fixture();
    const registration = {
      ...device,
      pushToken: "b".repeat(64),
      preferences: {
        ...device.preferences,
        liveActivitiesEnabled: false,
        notificationsEnabled: true,
      },
    };
    expect((await request("/v1/mobile/devices", registration)).status).toBe(200);
    expect(bridge.devices.get(device.deviceId)).toMatchObject({
      enabled: false,
      pushToken: registration.pushToken,
      preferences: registration.preferences,
    });
    expect((await request("/health")).status).toBe(200);
    await request("/v1/mobile/devices", {
      ...registration,
      preferences: { ...registration.preferences, notificationsEnabled: false },
    });
    expect(bridge.devices.get(device.deviceId)?.pushToken).toBeUndefined();
    expect(
      (await request("/v1/mobile/devices", { ...registration, pushToken: "bad-token" })).status,
    ).toBe(400);
  });
  it("rejects missing or different Tailscale identities", async () => {
    const { request } = await fixture();
    expect((await request("/health", undefined, "")).status).toBe(403);
    expect((await request("/health", undefined, "someone-else@example.test")).status).toBe(403);
  });
  it("does not pretend registration works without Apple credentials", async () => {
    const { request } = await fixture(false);
    expect((await request("/v1/mobile/devices", device)).status).toBe(503);
  });
  it("validates app identity, pairs the activity, and handles disabling", async () => {
    const { request, bridge } = await fixture();
    expect(
      (await request("/v1/mobile/devices", { ...device, apsEnvironment: "production" })).status,
    ).toBe(400);
    expect((await request("/v1/mobile/devices", device)).status).toBe(200);
    expect(
      (
        await request("/v1/mobile/live-activities", {
          deviceId: device.deviceId,
          activityPushToken: "a".repeat(64),
        })
      ).status,
    ).toBe(200);
    expect(bridge.devices.get(device.deviceId)?.token).toBe("a".repeat(64));
    expect(
      (
        await request("/v1/mobile/devices", {
          ...device,
          preferences: { ...device.preferences, liveActivitiesEnabled: false },
        })
      ).status,
    ).toBe(200);
    expect(bridge.devices.get(device.deviceId)?.enabled).toBe(false);
  });
  it("rejects invalid activity tokens and registrations without a device", async () => {
    const { request } = await fixture();
    expect(
      (
        await request("/v1/mobile/live-activities", {
          deviceId: "missing",
          activityPushToken: "a".repeat(64),
        })
      ).status,
    ).toBe(400);
    await request("/v1/mobile/devices", device);
    expect(
      (
        await request("/v1/mobile/live-activities", {
          deviceId: device.deviceId,
          activityPushToken: "../../invalid",
        })
      ).status,
    ).toBe(400);
  });
});
