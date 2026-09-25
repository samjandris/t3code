// @effect-diagnostics nodeBuiltinImport:off - Native Node helper runtime.
// @effect-diagnostics globalConsole:off - Native Node helper runtime.
// @effect-diagnostics globalDate:off - Native Node helper runtime.
// @effect-diagnostics globalTimers:off - Native Node helper runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeHttp from "node:http";
import { createApnsSender } from "./apns.ts";
import { ActivityBridge, type RegisteredDevice } from "./bridge.ts";
import { createHandler } from "./http.ts";
import { createConnectClient } from "./connect.ts";
import { ActivityFeed, decodeCredentials } from "./feed.ts";
import { watchEnvironment } from "./watcher.ts";
import { CredentialRenewal, decodeRenewalTargets } from "./renewal.ts";
import { NotificationBridge } from "./notifications.ts";

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}
const statePath = required("ACTIVITY_BRIDGE_STATE_PATH");
const login = required("ACTIVITY_BRIDGE_TAILSCALE_LOGIN");
const bundleId = required("APNS_BUNDLE_ID");
const environment = required("APNS_ENVIRONMENT");
if (environment !== "sandbox" && environment !== "production")
  throw new Error("Invalid APNS_ENVIRONMENT");
const keyPath = process.env.APNS_KEY_PATH;
const pushReady = Boolean(keyPath && process.env.APNS_KEY_ID);
const apns = pushReady
  ? createApnsSender({
      keyPath: keyPath!,
      keyId: required("APNS_KEY_ID"),
      teamId: required("APNS_TEAM_ID"),
      bundleId,
      environment,
    })
  : null;
const sender =
  apns ??
  (async () => {
    throw new Error("APNs not configured");
  });
NodeFS.mkdirSync(NodePath.dirname(statePath), { recursive: true, mode: 0o700 });
const bridge = new ActivityBridge(sender, () => {
  NodeFS.writeFileSync(`${statePath}.tmp`, JSON.stringify([...bridge.devices.values()]), {
    mode: 0o600,
  });
  NodeFS.renameSync(`${statePath}.tmp`, statePath);
});
try {
  for (const device of JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as RegisteredDevice[])
    bridge.devices.set(device.deviceId, device);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const client = createConnectClient(required("ACTIVITY_BRIDGE_CONNECT_SESSION_PATH"));
const notifications = new NotificationBridge(bridge, sender);
const feed = new ActivityFeed(bridge, watchEnvironment, notifications);
const credentialsPath = required("ACTIVITY_BRIDGE_ENVIRONMENTS_PATH");
const renewal = new CredentialRenewal();
const maintenanceController = new AbortController();
let maintaining = false;
let discovering = false;
async function discover() {
  if (discovering) return;
  discovering = true;
  try {
    const environments = await client.listEnvironments();
    const credentials = decodeCredentials(JSON.parse(NodeFS.readFileSync(credentialsPath, "utf8")));
    feed.reconcile(environments, credentials, Date.now());
    if (!maintaining) {
      const targetsPath = process.env.ACTIVITY_BRIDGE_RENEWAL_TARGETS_PATH;
      const targets = targetsPath
        ? decodeRenewalTargets(JSON.parse(NodeFS.readFileSync(targetsPath, "utf8")))
        : {};
      maintaining = true;
      void Promise.all(
        environments.map(async (environment) => {
          const id = environment.environmentId;
          const credential = credentials[id];
          const url = credential?.url ?? environment.endpoint?.httpBaseUrl;
          if (!credential || !url) return;
          if (
            await renewal.check(
              id,
              credential,
              url,
              targets[id],
              Date.now(),
              maintenanceController.signal,
            )
          ) {
            console.info("Activity credential renewed", { environmentId: id });
            feed.invalidateCredential(id);
          }
        }),
      )
        .catch(() => console.warn("Activity credential maintenance failed; details withheld"))
        .finally(() => {
          maintaining = false;
        });
    }
  } catch {
    console.warn("Activity server discovery failed; retrying");
  } finally {
    discovering = false;
  }
}
const server = NodeHttp.createServer(
  createHandler(
    { login, bundleId, environment, pushReady },
    bridge,
    () => feed.refresh(Date.now()),
    () =>
      feed.status().map((environment) => ({
        ...environment,
        credential: renewal.health(environment.environmentId),
      })),
  ),
);
server.requestTimeout = 15_000;
server.listen(Number(process.env.ACTIVITY_BRIDGE_PORT ?? 43130), "127.0.0.1", () =>
  console.info("Activity helper listening on loopback", { pushReady }),
);
const timer = setInterval(() => {
  feed.refresh(Date.now());
  void notifications.flush(Date.now());
}, 5_000);
const discoveryTimer = setInterval(() => {
  void discover();
}, 60_000);
void discover();
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    clearInterval(timer);
    clearInterval(discoveryTimer);
    maintenanceController.abort();
    feed.dispose();
    apns?.close();
    server.close();
  });
