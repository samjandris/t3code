// @effect-diagnostics nodeBuiltinImport:off - Test native HTTP/2 and temporary key files.
import * as NodeHttp2 from "node:http2";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createApnsSender } from "./apns.ts";
vi.mock("node:http2", async (original) => {
  const actual = await original<typeof NodeHttp2>();
  return { ...actual, connect: vi.fn(actual.connect) };
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
async function fixture() {
  const actual = await vi.importActual<typeof NodeHttp2>("node:http2");
  const server = actual.createServer();
  const sessions = new Set<NodeHttp2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address() as { port: number };
  const clients: NodeHttp2.ClientHttp2Session[] = [];
  vi.mocked(NodeHttp2.connect).mockImplementation(() => {
    const client = actual.connect(`http://127.0.0.1:${address.port}`);
    clients.push(client);
    return client;
  });
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "apns-test-"));
  const keyPath = NodePath.join(directory, "key");
  NodeFS.writeFileSync(
    keyPath,
    NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }),
    { mode: 0o600 },
  );
  const sender = createApnsSender({
    keyPath,
    keyId: "test",
    teamId: "test",
    bundleId: "test",
    environment: "sandbox",
  });
  cleanup.push(async () => {
    sender.close();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    NodeFS.rmSync(directory, { recursive: true });
  });
  const send = () => sender({ token: "test", event: "update", aggregate: null });
  return { sender, send, server, sessions, clients };
}
describe("APNs persistent connection", () => {
  it("reuses a session across concurrent and sequential pushes including an APNs rejection", async () => {
    const f = await fixture();
    let requests = 0;
    f.server.on("stream", (stream) => {
      stream.resume();
      const bad = ++requests === 2;
      stream.respond({ ":status": bad ? 400 : 200 });
      stream.end(bad ? JSON.stringify({ reason: "BadDeviceToken" }) : undefined);
    });
    const replies = await Promise.all([f.send(), f.send()]);
    expect(replies.map((r) => r.status)).toEqual([200, 400]);
    expect(replies[1]?.reason).toBe("BadDeviceToken");
    expect((await f.send()).ok).toBe(true);
    expect(f.sessions.size).toBe(1);
  });
  it("opens a fresh connection after GOAWAY", async () => {
    const f = await fixture();
    f.server.on("stream", (stream) => {
      stream.resume();
      stream.respond({ ":status": 200 });
      stream.end();
    });
    await f.send();
    const received = NodeEvents.EventEmitter.once(f.clients[0]!, "goaway");
    [...f.sessions][0]!.goaway();
    await received;
    expect((await f.send()).ok).toBe(true);
    expect(f.sessions.size).toBe(2);
  });
  it("rejects interrupted requests and reconnects for the next push", async () => {
    const f = await fixture();
    f.server.once("stream", (stream) => {
      stream.on("error", () => {});
      stream.session!.destroy();
    });
    await expect(f.send()).rejects.toThrow();
    f.server.on("stream", (stream) => {
      stream.resume();
      stream.respond({ ":status": 200 });
      stream.end();
    });
    expect((await f.send()).ok).toBe(true);
    f.sender.close();
    await expect(f.send()).rejects.toThrow("closed");
  });
  it("times out a stalled stream and replaces the connection", async () => {
    const f = await fixture();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const received = NodeEvents.EventEmitter.once(f.server, "stream");
    const pending = expect(f.send()).rejects.toThrow("timed out");
    const [stream] = await received;
    stream.on("error", () => {});
    stream.resume();
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    vi.useRealTimers();
    f.server.on("stream", (next) => {
      next.resume();
      next.respond({ ":status": 200 });
      next.end();
    });
    expect((await f.send()).ok).toBe(true);
    expect(f.sessions.size).toBe(2);
  });
});
