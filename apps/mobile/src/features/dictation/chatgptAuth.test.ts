import { describe, expect, it, vi } from "vite-plus/test";

import {
  beginChatGptDeviceLogin,
  completeChatGptDeviceLogin,
  parseStoredChatGptAuthSession,
  refreshChatGptAuthSession,
  type ChatGptAuthSession,
} from "./chatgptAuth";

describe("ChatGPT device login", () => {
  it("requests a device code with the Codex OAuth client", async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(
        Response.json({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: "3",
        }),
      ),
    );

    await expect(
      beginChatGptDeviceLogin({ fetchImpl: fetchMock as unknown as typeof fetch }),
    ).resolves.toEqual({
      deviceAuthId: "device-auth-id",
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
      intervalMs: 3_000,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    });
  });

  it("polls pending login, exchanges the code, and reads account claims", async () => {
    const accessToken = jwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "pro",
      },
    });
    const idToken = jwt({
      "https://api.openai.com/profile": { email: "sam@example.com" },
    });
    const responses = [
      new Response(null, { status: 403 }),
      Response.json({
        authorization_code: "authorization-code",
        code_challenge: "challenge",
        code_verifier: "verifier",
      }),
      Response.json({ access_token: accessToken, id_token: idToken, refresh_token: "refresh-1" }),
    ];
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(responses.shift()!),
    );
    const sleep = vi.fn(() => Promise.resolve());

    const session = await completeChatGptDeviceLogin(
      {
        deviceAuthId: "device-auth-id",
        userCode: "ABCD-EFGH",
        verificationUrl: "https://auth.openai.com/codex/device",
        intervalMs: 3_000,
      },
      { fetchImpl: fetchMock as unknown as typeof fetch, sleep },
    );

    expect(sleep).toHaveBeenCalledWith(3_000, undefined);
    expect(session).toMatchObject({
      accountId: "account-1",
      email: "sam@example.com",
      planType: "pro",
      expiresAtMs: 2_000_000_000_000,
      refreshToken: "refresh-1",
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://auth.openai.com/oauth/token");
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toContain("code_verifier=verifier");
  });

  it("works with a mobile AbortSignal that lacks throwIfAborted", async () => {
    const accessToken = jwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    });
    const idToken = jwt({ chatgpt_account_id: "account-1" });
    const responses = [
      Response.json({
        authorization_code: "authorization-code",
        code_challenge: "challenge",
        code_verifier: "verifier",
      }),
      Response.json({
        access_token: accessToken,
        id_token: idToken,
        refresh_token: "refresh-1",
      }),
    ];
    const fetchMock = vi.fn(() => Promise.resolve(responses.shift()!));
    const signal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await expect(
      completeChatGptDeviceLogin(
        {
          deviceAuthId: "device-auth-id",
          userCode: "ABCD-EFGH",
          verificationUrl: "https://auth.openai.com/codex/device",
          intervalMs: 3_000,
        },
        { fetchImpl: fetchMock as unknown as typeof fetch, signal },
      ),
    ).resolves.toMatchObject({ accountId: "account-1", refreshToken: "refresh-1" });
  });

  it("refreshes with JSON and keeps tokens omitted by the refresh response", async () => {
    const session = makeSession();
    const fetchMock = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(Response.json({ access_token: session.accessToken })),
    );

    await expect(
      refreshChatGptAuthSession(session, { fetchImpl: fetchMock as unknown as typeof fetch }),
    ).resolves.toEqual(session);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
    });
  });

  it("rejects invalid persisted values", () => {
    expect(parseStoredChatGptAuthSession("not-json")).toBeNull();
    expect(parseStoredChatGptAuthSession('{"version":1}')).toBeNull();
  });
});

function makeSession(): ChatGptAuthSession {
  return {
    version: 1,
    accessToken: jwt({
      exp: 2_000_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "account-1",
        chatgpt_plan_type: "pro",
      },
    }),
    idToken: jwt({ "https://api.openai.com/profile": { email: "sam@example.com" } }),
    refreshToken: "refresh-1",
    accountId: "account-1",
    email: "sam@example.com",
    planType: "pro",
    expiresAtMs: 2_000_000_000_000,
  };
}

function jwt(payload: Record<string, unknown>): string {
  const encoded = btoa(JSON.stringify(payload))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `header.${encoded}.signature`;
}
