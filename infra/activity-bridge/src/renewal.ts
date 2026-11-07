// @effect-diagnostics nodeBuiltinImport:off - Native Node credential maintenance.
// @effect-diagnostics globalFetch:off - Native Node credential maintenance.
// @effect-diagnostics globalDate:off - Compare server-issued credential expiry.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

const Target = Schema.Struct({
  binary: Schema.String,
  entry: Schema.optional(Schema.String),
  url: Schema.String,
  ssh: Schema.optional(Schema.Array(Schema.String)),
});
export const decodeRenewalTargets = Schema.decodeUnknownSync(Schema.Record(Schema.String, Target));
type Target = typeof Target.Type;
export interface CredentialHealth {
  expiresAt?: string | undefined;
  status: "valid" | "expiring" | "expired" | "unauthorized" | "unavailable" | "renewal_failed";
  automaticRenewal: boolean;
  checkedAt: string;
}
const hour = 60 * 60_000;
export const renewalDue = (expiresAt: string, now: number) =>
  Date.parse(expiresAt) - now <= 7 * 24 * hour;

/** Runs through the installed CLI on the server machine, never an app database. */
function pairingProgram(target: Target, environmentId: string) {
  return `
const {execFileSync} = require('node:child_process');
(async () => {
  const config = ${JSON.stringify({ ...target, ssh: undefined })};
  const descriptor = await fetch(new URL('/.well-known/t3/environment', config.url), {signal: AbortSignal.timeout(10000)});
  if (!descriptor.ok || (await descriptor.json()).environmentId !== ${JSON.stringify(environmentId)}) throw new Error();
  const output = execFileSync(config.binary, [...(config.entry ? [config.entry] : []), 'pair', '--label', 'Live Activity helper'], {
    cwd: require('node:os').homedir(), encoding: 'utf8', timeout: 20000, maxBuffer: 1048576,
    env: {...process.env, ...(config.entry ? {ELECTRON_RUN_AS_NODE: '1'} : {})}, stdio: ['ignore', 'pipe', 'pipe']
  });
  const credential = /Token: ([A-Za-z0-9._~-]+)/.exec(output)?.[1];
  if (!credential) throw new Error();
  const response = await fetch(new URL('/oauth/token', config.url), {
    method: 'POST', signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange', subject_token: credential,
      subject_token_type: 'urn:t3:params:oauth:token-type:environment-bootstrap', requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: 'orchestration:read', client_label: 'Live Activity helper', client_device_type: 'bot', client_os: 'linux'})
  });
  if (!response.ok) throw new Error();
  const result = await response.json();
  if (result.scope !== 'orchestration:read' || typeof result.access_token !== 'string') throw new Error();
  process.stdout.write(JSON.stringify(result));
})().catch(() => {process.stderr.write('Pairing failed; details withheld\\n'); process.exitCode = 1;});
`;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export async function issueCredential(target: Target, environmentId: string, signal?: AbortSignal) {
  const runtime = target.entry ? target.binary : process.execPath;
  const args = ["--input-type=commonjs", "-"];
  const remote = `${target.entry ? "ELECTRON_RUN_AS_NODE=1 " : ""}${[runtime, ...args].map(quote).join(" ")}`;
  const output = await new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.execFile(
      target.ssh ? "ssh" : runtime,
      target.ssh ? [...target.ssh, remote] : args,
      {
        timeout: 50_000,
        maxBuffer: 1024 * 1024,
        signal,
        env: { ...process.env, ...(target.entry ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      },
      (error, stdout) =>
        error ? reject(new Error("Credential renewal command failed")) : resolve(stdout),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(pairingProgram(target, environmentId));
  });
  const result = JSON.parse(output) as { access_token?: unknown; scope?: unknown };
  if (
    result.scope !== "orchestration:read" ||
    typeof result.access_token !== "string" ||
    !result.access_token
  )
    throw new Error("Invalid renewal response");
  return result.access_token;
}
export async function inspectCredential(
  url: string,
  token: string,
  environmentId: string,
  signal?: AbortSignal,
) {
  const descriptor = await fetch(new URL("/.well-known/t3/environment", url), {
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
  });
  if (
    !descriptor.ok ||
    ((await descriptor.json()) as { environmentId?: string }).environmentId !== environmentId
  )
    throw new Error("Environment identity mismatch");
  const response = await fetch(new URL("/api/auth/session", url), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw new Error("Credential inspection failed");
  const result = (await response.json()) as {
    authenticated: boolean;
    expiresAt?: string | undefined;
    scopes?: string[];
  };
  if (!result.authenticated) return null;
  if (
    result.scopes?.length !== 1 ||
    result.scopes[0] !== "orchestration:read" ||
    !result.expiresAt ||
    !Number.isFinite(Date.parse(result.expiresAt))
  )
    throw new Error("Unexpected credential scope or expiry");
  return result.expiresAt;
}
export class CredentialRenewal {
  private records = new Map<
    string,
    CredentialHealth & { fingerprint: string; nextCheck: number }
  >();
  private readonly inspect: typeof inspectCredential;
  private readonly issue: typeof issueCredential;
  constructor(inspect = inspectCredential, issue = issueCredential) {
    this.inspect = inspect;
    this.issue = issue;
  }
  health(id: string) {
    const record = this.records.get(id);
    if (!record) return undefined;
    const { fingerprint: _, nextCheck: __, ...health } = record;
    return health;
  }
  async check(
    id: string,
    credential: { tokenPath: string },
    url: string,
    target: Target | undefined,
    now: number,
    signal?: AbortSignal,
  ) {
    const previous = this.records.get(id);
    let fingerprint = "";
    let skipped = false;
    const record = {
      ...previous,
      fingerprint,
      nextCheck: now + hour,
      checkedAt: new Date(now).toISOString(),
      automaticRenewal: Boolean(target),
      status: "unavailable" as CredentialHealth["status"],
    };
    try {
      const token = NodeFS.readFileSync(credential.tokenPath, "utf8").trim();
      fingerprint = NodeCrypto.createHash("sha256").update(token).digest("hex");
      if (previous?.fingerprint === fingerprint && previous.nextCheck > now) {
        skipped = true;
        return false;
      }
      record.fingerprint = fingerprint;
      const expiry = await this.inspect(url, token, id, signal);
      record.expiresAt = expiry ?? undefined;
      record.status = expiry
        ? Date.parse(expiry) <= now
          ? "expired"
          : renewalDue(expiry, now)
            ? "expiring"
            : "valid"
        : "unauthorized";
      if (target && (!expiry || renewalDue(expiry, now))) {
        record.status = "renewal_failed";
        const replacement = await this.issue(target, id, signal);
        const replacementExpiry = await this.inspect(url, replacement, id, signal);
        if (!replacementExpiry || renewalDue(replacementExpiry, now))
          throw new Error("Replacement credential is not valid long enough");
        const temporary = `${credential.tokenPath}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          NodeFS.writeFileSync(temporary, replacement, { mode: 0o600, flag: "wx" });
          NodeFS.renameSync(temporary, credential.tokenPath);
        } finally {
          NodeFS.rmSync(temporary, { force: true });
        }
        record.expiresAt = replacementExpiry;
        record.status = "valid";
        record.fingerprint = NodeCrypto.createHash("sha256").update(replacement).digest("hex");
        return true;
      }
    } catch {
      // Never log child output, fetch errors, or token-bearing command details.
    } finally {
      if (!skipped) this.records.set(id, record);
    }
    return false;
  }
}
