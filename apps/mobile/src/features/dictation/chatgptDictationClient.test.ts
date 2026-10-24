import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ChatGptAuthSession } from "./chatgptAuth";

const authStoreMocks = vi.hoisted(() => ({
  getValidChatGptAuthSession: vi.fn(),
}));

vi.mock("./chatgptAuthStore", () => authStoreMocks);
vi.mock("expo-file-system", () => ({
  File: class MockFile extends Blob {
    constructor(readonly uri: string) {
      super(["recording"], { type: "audio/mp4" });
    }
  },
}));

import {
  cleanDictationTranscript,
  insertDictationText,
  transcribeAndCleanRecording,
} from "./chatgptDictationClient";

describe("ChatGPT dictation client", () => {
  beforeEach(() => {
    authStoreMocks.getValidChatGptAuthSession.mockReset();
    authStoreMocks.getValidChatGptAuthSession.mockResolvedValue(makeSession());
  });

  it("passes the transcript and composer context to Luna cleanup", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"Fix the "}',
            'data: {"type":"response.output_text.delta","delta":"login."}',
            "data: [DONE]",
          ].join("\n\n"),
        ),
      );

    await expect(
      cleanDictationTranscript({
        transcript: "um fix the login",
        surroundingText: "We need to update auth.ts.",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toBe("Fix the login.");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "ChatGPT-Account-ID": "account-1",
      originator: "Codex Desktop",
    });
    const cleanupBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(cleanupBody).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "low" },
      store: false,
      stream: true,
      tools: [],
    });
    expect(cleanupBody.input[0].content[0].text).toContain(
      "Surrounding text:\nWe need to update auth.ts.",
    );
  });

  it("uploads the recording to Codex's transcription fallback", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ text: "transcribed recording" }), {
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(
      transcribeAndCleanRecording({
        uri: "file:///dictation.m4a",
        surroundingText: "",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toBe("transcribed recording");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/transcribe");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer access-token",
      "ChatGPT-Account-ID": "account-1",
      originator: "Codex Desktop",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://chatgpt.com/backend-api/codex/responses");
  });

  it("keeps the raw transcript when cleanup fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 500 }));

    await expect(
      cleanDictationTranscript({
        transcript: "raw transcript",
        surroundingText: "",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).resolves.toBe("raw transcript");
  });

  it("does not insert a transcript after cleanup is cancelled", async () => {
    const abortError = new Error("cancelled");
    abortError.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValueOnce(abortError);

    await expect(
      cleanDictationTranscript({
        transcript: "cancelled transcript",
        surroundingText: "",
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toBe(abortError);
  });

  it("inserts without changing existing draft whitespace", () => {
    expect(insertDictationText("", " hello ")).toBe("hello");
    expect(insertDictationText("Existing", "addition")).toBe("Existing addition");
    expect(insertDictationText("Existing\n", "addition")).toBe("Existing\naddition");
  });
});

function makeSession(): ChatGptAuthSession {
  return {
    version: 1,
    accessToken: "access-token",
    idToken: "id-token",
    refreshToken: "refresh-token",
    accountId: "account-1",
    email: "sam@example.com",
    planType: "pro",
    expiresAtMs: Date.now() + 60_000,
  };
}
