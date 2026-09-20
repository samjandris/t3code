// @effect-diagnostics nodeBuiltinImport:off - Local CLI provisions a narrowly scoped observer credential.
// @effect-diagnostics globalFetch:off - Local CLI provisions a narrowly scoped observer credential.
// @effect-diagnostics globalConsole:off - Never print credentials or captured pairing output.
// @effect-diagnostics globalDate:off - Record credential expiry for the operator.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";

const tokenPath = process.env.ACTIVITY_BRIDGE_ENVIRONMENT_TOKEN_PATH;
const baseUrl = process.env.ACTIVITY_BRIDGE_ENVIRONMENT_URL;
if (!tokenPath || !baseUrl) throw new Error("Load bridge.env before running the pairing command");
// This CLI pairs with the local installed T3 server, not the development worktree.
let output: string;
try {
  output = NodeChildProcess.execFileSync(
    process.env.ACTIVITY_BRIDGE_CLI_BINARY ?? "t3",
    [
      ...(process.env.ACTIVITY_BRIDGE_CLI_ENTRY ? [process.env.ACTIVITY_BRIDGE_CLI_ENTRY] : []),
      "pair",
      "--label",
      "Live Activity helper bootstrap",
    ],
    {
      cwd: NodeOS.homedir(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
} catch {
  throw new Error("Local pairing command failed; output withheld");
}
const credential = /Token: ([A-Za-z0-9._~-]+)/.exec(output)?.[1];
if (!credential) throw new Error("Pairing output was not recognized; output withheld");
const response = await fetch(new URL("/oauth/token", baseUrl), {
  method: "POST",
  body: new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: credential,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    scope: "orchestration:read",
    client_label: "Live Activity helper",
    client_device_type: "bot",
    client_os: "linux",
  }),
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`Pairing exchange failed: HTTP ${response.status}`);
const result = (await response.json()) as {
  access_token: string;
  scope: string;
  expires_in: number;
};
if (result.scope !== "orchestration:read" || !result.access_token)
  throw new Error("Unexpected pairing result");
NodeFS.mkdirSync(NodePath.dirname(tokenPath), { recursive: true, mode: 0o700 });
NodeFS.writeFileSync(tokenPath, result.access_token, { mode: 0o600 });
NodeFS.chmodSync(tokenPath, 0o600);
console.info(
  "Read-only helper credential saved. Revoke the previous helper session in T3 Connections after renewal. Expires:",
  new Date(Date.now() + result.expires_in * 1_000).toISOString(),
);
