// @effect-diagnostics nodeBuiltinImport:off - Headless helper authentication.
// @effect-diagnostics globalFetch:off - Headless helper authentication.
// @effect-diagnostics globalConsole:off - Print only the one-time authorization URL.
// @effect-diagnostics globalDate:off - Bound the device authorization lifetime.
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { CONNECT_OAUTH_SCOPES } from "@t3tools/shared/connectAuth";
import { connectClientId, connectIssuer, saveSession } from "./connect.ts";

const path = process.env.ACTIVITY_BRIDGE_CONNECT_SESSION_PATH;
if (!path) throw new Error("Load bridge.env before running login");
const response = await fetch(`${connectIssuer}/oauth/device_authorization`, {
  method: "POST",
  body: new URLSearchParams({ client_id: connectClientId, scope: CONNECT_OAUTH_SCOPES.join(" ") }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Device authorization failed: ${response.status}`);
const authorization = Schema.decodeUnknownSync(
  Schema.Struct({
    device_code: Schema.String,
    user_code: Schema.String,
    verification_uri: Schema.String,
    expires_in: Schema.Finite,
    interval: Schema.optional(Schema.Finite),
  }),
)(await response.json());
console.info(`Open ${authorization.verification_uri} and enter ${authorization.user_code}.`);
const deadline = Date.now() + authorization.expires_in * 1_000;
let interval = (authorization.interval ?? 5) * 1_000;
while (Date.now() < deadline) {
  await NodeTimersPromises.setTimeout(interval);
  let result: Response;
  try {
    result = await fetch(`${connectIssuer}/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: connectClientId,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: authorization.device_code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    interval += 5_000;
    continue;
  }
  if (result.status >= 500) {
    await result.body?.cancel();
    interval += 5_000;
    continue;
  }
  if (result.ok) {
    const token = Schema.decodeUnknownSync(
      Schema.Struct({
        access_token: Schema.String,
        refresh_token: Schema.String,
        expires_in: Schema.Finite,
      }),
    )(await result.json());
    NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true, mode: 0o700 });
    saveSession(path, {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: Date.now() + token.expires_in * 1_000,
    });
    console.info("Helper session saved. Restart t3-activity-bridge.service.");
    process.exit(0);
  }
  const failure = Schema.decodeUnknownSync(Schema.Struct({ error: Schema.String }))(
    await result.json(),
  );
  if (failure.error === "slow_down") interval += 5_000;
  else if (failure.error !== "authorization_pending")
    throw new Error("Device authorization denied or expired. Run login again.");
}
throw new Error("Device authorization expired. Run login again.");
