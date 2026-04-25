import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { makePiRpcRuntime } from "./PiRpcRuntime.ts";

describe("PiRpcRuntime", () => {
  it("sends documented top-level type commands over JSONL", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        if (process.platform === "win32") {
          return;
        }
        const tempDir = mkdtempSync(path.join(tmpdir(), "t3-pi-rpc-runtime-"));
        const fakePiPath = path.join(tempDir, "pi");
        writeFileSync(
          fakePiPath,
          `#!/usr/bin/env node
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    process.stdout.write(JSON.stringify({
      id: request.id,
      type: "response",
      command: request.type,
      success: true,
      data: {
        models: [{ provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" }],
        received: request
      }
    }) + "\\n");
  }
});
`,
        );
        chmodSync(fakePiPath, 0o755);

        const runtime = yield* makePiRpcRuntime({
          binaryPath: fakePiPath,
          cwd: tempDir,
          noSession: true,
        });

        const response = yield* runtime.getAvailableModels();
        expect(response).toMatchObject({
          received: {
            type: "get_available_models",
          },
        });
        expect((response as { received: Record<string, unknown> }).received).not.toHaveProperty(
          "method",
        );
        expect((response as { received: Record<string, unknown> }).received).not.toHaveProperty(
          "params",
        );
      }).pipe(Effect.scoped),
    );
  });
});
