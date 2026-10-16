const AUTH_BASE_URL = "https://auth.openai.com";
const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface ChatGptAuthSession {
  readonly version: 1;
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
  readonly accountId: string;
  readonly email: string | null;
  readonly planType: string | null;
  readonly expiresAtMs: number | null;
}

export interface ChatGptDeviceLogin {
  readonly deviceAuthId: string;
  readonly userCode: string;
  readonly verificationUrl: string;
  readonly intervalMs: number;
}

interface AuthRequestOptions {
  readonly fetchImpl?: typeof fetch;
  readonly signal?: AbortSignal;
}

interface CompleteDeviceLoginOptions extends AuthRequestOptions {
  readonly now?: () => number;
  readonly sleep?: (durationMs: number, signal?: AbortSignal) => Promise<void>;
}

export async function beginChatGptDeviceLogin(
  options: AuthRequestOptions = {},
): Promise<ChatGptDeviceLogin> {
  const response = await (options.fetchImpl ?? fetch)(
    `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
      signal: options.signal,
    },
  );
  if (!response.ok) {
    throw new Error(`ChatGPT device login could not start (${response.status}).`);
  }

  const body = asRecord(await response.json());
  const deviceAuthId = requiredString(body, "device_auth_id");
  const userCode = stringValue(body.user_code) ?? requiredString(body, "usercode");
  const intervalSeconds = Number(body.interval);

  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${AUTH_BASE_URL}/codex/device`,
    intervalMs: Number.isFinite(intervalSeconds) ? Math.max(1_000, intervalSeconds * 1_000) : 5_000,
  };
}

export async function completeChatGptDeviceLogin(
  login: ChatGptDeviceLogin,
  options: CompleteDeviceLoginOptions = {},
): Promise<ChatGptAuthSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + DEVICE_LOGIN_TIMEOUT_MS;

  while (now() < deadline) {
    throwIfSignalAborted(options.signal);
    const response = await fetchImpl(`${AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: login.deviceAuthId,
        user_code: login.userCode,
      }),
      signal: options.signal,
    });

    if (response.ok) {
      const body = asRecord(await response.json());
      return exchangeAuthorizationCode(
        {
          authorizationCode: requiredString(body, "authorization_code"),
          codeVerifier: requiredString(body, "code_verifier"),
        },
        options,
      );
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`ChatGPT device login failed (${response.status}).`);
    }
    await sleep(Math.min(login.intervalMs, Math.max(0, deadline - now())), options.signal);
  }

  throw new Error("ChatGPT device login expired. Start again to get a new code.");
}

export async function refreshChatGptAuthSession(
  session: ChatGptAuthSession,
  options: AuthRequestOptions = {},
): Promise<ChatGptAuthSession> {
  const response = await (options.fetchImpl ?? fetch)(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CODEX_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`ChatGPT sign-in could not be refreshed (${response.status}).`);
  }

  const body = asRecord(await response.json());
  return sessionFromTokens({
    accessToken: stringValue(body.access_token) ?? session.accessToken,
    idToken: stringValue(body.id_token) ?? session.idToken,
    refreshToken: stringValue(body.refresh_token) ?? session.refreshToken,
  });
}

export async function revokeChatGptAuthSession(
  session: ChatGptAuthSession,
  options: AuthRequestOptions = {},
): Promise<void> {
  const response = await (options.fetchImpl ?? fetch)(`${AUTH_BASE_URL}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: session.refreshToken,
      token_type_hint: "refresh_token",
      client_id: CODEX_OAUTH_CLIENT_ID,
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`ChatGPT sign-out could not revoke the token (${response.status}).`);
  }
}

export function parseStoredChatGptAuthSession(value: string): ChatGptAuthSession | null {
  try {
    const parsed = asRecord(JSON.parse(value));
    if (
      parsed.version !== 1 ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.idToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.accountId !== "string"
    ) {
      return null;
    }
    return {
      version: 1,
      accessToken: parsed.accessToken,
      idToken: parsed.idToken,
      refreshToken: parsed.refreshToken,
      accountId: parsed.accountId,
      email: stringValue(parsed.email),
      planType: stringValue(parsed.planType),
      expiresAtMs: typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : null,
    };
  } catch {
    return null;
  }
}

async function exchangeAuthorizationCode(
  input: { readonly authorizationCode: string; readonly codeVerifier: string },
  options: AuthRequestOptions,
): Promise<ChatGptAuthSession> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.authorizationCode,
    redirect_uri: `${AUTH_BASE_URL}/deviceauth/callback`,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: input.codeVerifier,
  });
  const response = await (options.fetchImpl ?? fetch)(`${AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`ChatGPT device login could not finish (${response.status}).`);
  }

  const tokens = asRecord(await response.json());
  return sessionFromTokens({
    accessToken: requiredString(tokens, "access_token"),
    idToken: requiredString(tokens, "id_token"),
    refreshToken: requiredString(tokens, "refresh_token"),
  });
}

function sessionFromTokens(input: {
  readonly accessToken: string;
  readonly idToken: string;
  readonly refreshToken: string;
}): ChatGptAuthSession {
  const accessClaims = decodeJwtPayload(input.accessToken);
  const idClaims = decodeJwtPayload(input.idToken);
  const authClaims = nestedRecord(accessClaims, "https://api.openai.com/auth");
  const profileClaims = nestedRecord(idClaims, "https://api.openai.com/profile");
  const accountId =
    stringValue(idClaims.chatgpt_account_id) ??
    stringValue(accessClaims.chatgpt_account_id) ??
    stringValue(authClaims.chatgpt_account_id);
  if (!accountId) {
    throw new Error("ChatGPT login did not return an account identifier.");
  }
  const expiresAtSeconds =
    typeof accessClaims.exp === "number"
      ? accessClaims.exp
      : typeof idClaims.exp === "number"
        ? idClaims.exp
        : null;

  return {
    version: 1,
    accessToken: input.accessToken,
    idToken: input.idToken,
    refreshToken: input.refreshToken,
    accountId,
    email: stringValue(profileClaims.email) ?? stringValue(idClaims.email),
    planType: stringValue(authClaims.chatgpt_plan_type) ?? stringValue(idClaims.chatgpt_plan_type),
    expiresAtMs: expiresAtSeconds === null ? null : expiresAtSeconds * 1_000,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const encoded = token.split(".")[1];
  if (!encoded) throw new Error("ChatGPT login returned an invalid token.");
  const base64 = encoded
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  try {
    const binary = globalThis.atob(base64);
    const encodedJson = Array.from(
      binary,
      (character) => `%${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ).join("");
    return asRecord(JSON.parse(decodeURIComponent(encodedJson)));
  } catch {
    throw new Error("ChatGPT login returned an unreadable token.");
  }
}

function nestedRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const nested = value[key];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : {};
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ChatGPT returned an unexpected response.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = stringValue(value[key]);
  if (!result) throw new Error("ChatGPT returned an incomplete response.");
  return result;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function abortableSleep(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfSignalAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? abortError();
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
