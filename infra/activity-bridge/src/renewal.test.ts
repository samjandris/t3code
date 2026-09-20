// @effect-diagnostics nodeBuiltinImport:off - Test protected credential files.
// @effect-diagnostics globalDate:off - Fixed expiry fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CredentialRenewal, inspectCredential, renewalDue } from "./renewal.ts";
const directories: string[] = [];
const now = Date.parse("2026-09-20T00:00:00Z");
const hour = 3_600_000;
const expiry = (days: number) => new Date(now + days * 24 * hour).toISOString();
const target = { binary: "/installed/t3", url: "http://127.0.0.1:3773" };
function fixture() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bridge-renewal-"));
  directories.push(directory);
  const credential = { tokenPath: NodePath.join(directory, "token") };
  NodeFS.writeFileSync(credential.tokenPath, "old", { mode: 0o600 });
  const inspect = vi.fn<typeof inspectCredential>().mockResolvedValue(expiry(30));
  const issue = vi.fn().mockResolvedValue("new");
  const renewal = new CredentialRenewal(inspect, issue);
  const check = (time = now) => renewal.check("server", credential, target.url, target, time);
  return { directory, credential, inspect, issue, renewal, check };
}
afterEach(() => {
  for (const dir of directories.splice(0)) NodeFS.rmSync(dir, { recursive: true });
  vi.unstubAllGlobals();
});
describe("read-only credential renewal", () => {
  it("checks hourly without changing healthy credentials or health on skipped checks", async () => {
    const f = fixture();
    expect(await f.check()).toBe(false);
    const health = f.renewal.health("server");
    expect(await f.check(now + 60_000)).toBe(false);
    expect(f.renewal.health("server")).toEqual(health);
    expect(f.inspect).toHaveBeenCalledTimes(1);
    await f.check(now + hour);
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.issue).not.toHaveBeenCalled();
  });
  it("renews within seven days and atomically installs a validated private token", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce(expiry(7));
    expect(await f.check()).toBe(true);
    expect(NodeFS.readFileSync(f.credential.tokenPath, "utf8")).toBe("new");
    expect(NodeFS.statSync(f.credential.tokenPath).mode & 0o777).toBe(0o600);
    expect(NodeFS.readdirSync(f.directory)).toEqual(["token"]);
    expect(f.renewal.health("server")).toMatchObject({ status: "valid", expiresAt: expiry(30) });
    await f.check(now + 60_000);
    expect(f.issue).toHaveBeenCalledTimes(1);
  });
  it("recovers an expired token after an offline machine returns", async () => {
    const f = fixture();
    f.inspect.mockRejectedValueOnce(new Error("offline"));
    expect(await f.check()).toBe(false);
    expect(f.renewal.health("server")?.status).toBe("unavailable");
    await f.check(now + 60_000);
    expect(f.issue).not.toHaveBeenCalled();
    f.inspect.mockResolvedValueOnce(null);
    expect(await f.check(now + hour)).toBe(true);
    expect(f.issue).toHaveBeenCalledWith(target, "server", undefined);
    expect(NodeFS.readFileSync(f.credential.tokenPath, "utf8")).toBe("new");
  });
  it("preserves the previous credential after failed issuance or replacement validation", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce(expiry(2));
    f.issue.mockRejectedValueOnce(new Error("SSH failed"));
    expect(await f.check()).toBe(false);
    expect(f.renewal.health("server")?.status).toBe("renewal_failed");
    f.inspect.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    expect(await f.check(now + hour)).toBe(false);
    expect(NodeFS.readFileSync(f.credential.tokenPath, "utf8")).toBe("old");
  });
  it("rechecks externally rotated credentials immediately", async () => {
    const f = fixture();
    await f.check();
    NodeFS.writeFileSync(f.credential.tokenPath, "external");
    await f.check(now + 60_000);
    expect(f.inspect).toHaveBeenCalledTimes(2);
  });
  it("reports expiry without issuing a credential for unconfigured machines", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce(expiry(-1));
    await f.renewal.check("server", f.credential, target.url, undefined, now);
    expect(f.renewal.health("server")).toMatchObject({
      status: "expired",
      automaticRenewal: false,
    });
    expect(f.issue).not.toHaveBeenCalled();
    expect(renewalDue(expiry(8), now)).toBe(false);
  });
  it("rejects wrong environments before sending a token and rejects excessive scopes", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ environmentId: "wrong" }));
    vi.stubGlobal("fetch", fetch);
    await expect(inspectCredential(target.url, "secret", "server")).rejects.toThrow("identity");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockResolvedValueOnce(Response.json({ environmentId: "server" })).mockResolvedValueOnce(
      Response.json({
        authenticated: true,
        scopes: ["orchestration:read", "orchestration:write"],
        expiresAt: expiry(30),
      }),
    );
    await expect(inspectCredential(target.url, "secret", "server")).rejects.toThrow("scope");
  });
});
