// @effect-diagnostics nodeBuiltinImport:off - Native Node helper runtime.
// @effect-diagnostics globalFetch:off - Native Node helper runtime.
// @effect-diagnostics globalDate:off - Native Node helper runtime.
import * as NodeFS from "node:fs";
import * as Schema from "effect/Schema";
import { RelayListEnvironmentsResponse } from "@t3tools/contracts/relay";

// This session belongs to the helper. Never refresh a copy of a desktop's
// rotating credential or read/write the running server's secret store.
const Session = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  expiresAt: Schema.Finite,
});
export type ConnectSession = typeof Session.Type;
const decodeSession = Schema.decodeUnknownSync(Session);
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.Finite,
});
const decodeToken = Schema.decodeUnknownSync(TokenResponse);
const decodeEnvironments = Schema.decodeUnknownSync(RelayListEnvironmentsResponse);
export const connectClientId = "hzxSgY2cH10sDU2r";
export const connectIssuer = "https://clerk.t3.codes";

export function saveSession(path: string, session: ConnectSession) {
  NodeFS.writeFileSync(`${path}.tmp`, JSON.stringify(session), { mode: 0o600 });
  NodeFS.renameSync(`${path}.tmp`, path);
}

export function createTokenProvider(path: string, request = fetch, now = Date.now) {
  let pending: Promise<string> | undefined;
  return () => {
    if (pending) return pending;
    pending = (async () => {
      const session = decodeSession(JSON.parse(NodeFS.readFileSync(path, "utf8")));
      if (session.expiresAt - now() > 60_000) return session.accessToken;
      const response = await request(`${connectIssuer}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: connectClientId,
          grant_type: "refresh_token",
          refresh_token: session.refreshToken,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`T3 Connect session refresh failed: ${response.status}`);
      const token = decodeToken(await response.json());
      saveSession(path, {
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? session.refreshToken,
        expiresAt: now() + token.expires_in * 1_000,
      });
      return token.access_token;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}

export function createConnectClient(sessionPath: string) {
  const token = createTokenProvider(sessionPath);
  return {
    listEnvironments: async () => {
      const response = await fetch("https://relay.t3.codes/v1/environments", {
        headers: { authorization: `Bearer ${await token()}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`T3 Connect discovery failed: ${response.status}`);
      return decodeEnvironments(await response.json()).environments;
    },
  };
}
