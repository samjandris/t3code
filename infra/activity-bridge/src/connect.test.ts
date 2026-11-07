// @effect-diagnostics nodeBuiltinImport:off - Verify protected credential storage.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { createTokenProvider, saveSession } from "./connect.ts";
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) NodeFS.rmSync(directory, { recursive: true });
});
function fixture(expiresAt = 0) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "activity-session-"));
  directories.push(dir);
  const path = NodePath.join(dir, "session.json");
  saveSession(path, { accessToken: "old-access", refreshToken: "old-refresh", expiresAt });
  return path;
}
describe("helper-owned Connect login", () => {
  it("uses an unexpired credential without a network request", async () => {
    const request = vi.fn<typeof fetch>();
    const token = createTokenProvider(fixture(200000), request, () => 0);
    expect(await token()).toBe("old-access");
    expect(request).not.toHaveBeenCalled();
  });
  it("refreshes once for concurrent discovery and atomically saves rotated credentials", async () => {
    const path = fixture();
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 3600,
      }),
    );
    const token = createTokenProvider(path, request, () => 1000);
    expect(await Promise.all([token(), token()])).toEqual(["new-access", "new-access"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(NodeFS.readFileSync(path, "utf8"))).toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: 3601000,
    });
    expect(NodeFS.statSync(path).mode & 0o777).toBe(0o600);
  });
  it("preserves the prior credential on refresh failure and retries without exposing secrets", async () => {
    const path = fixture();
    const original = NodeFS.readFileSync(path, "utf8");
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("private upstream error", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ access_token: "new-access", expires_in: 3600 }));
    const token = createTokenProvider(path, request, () => 1000);
    await expect(token()).rejects.toThrow("T3 Connect session refresh failed: 503");
    expect(NodeFS.readFileSync(path, "utf8")).toBe(original);
    expect(await token()).toBe("new-access");
    expect(JSON.parse(NodeFS.readFileSync(path, "utf8")).refreshToken).toBe("old-refresh");
  });
});
