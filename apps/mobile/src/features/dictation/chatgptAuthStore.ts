import * as SecureStore from "expo-secure-store";

import {
  parseStoredChatGptAuthSession,
  refreshChatGptAuthSession,
  type ChatGptAuthSession,
} from "./chatgptAuth";

const STORAGE_KEY = "t3-mobile-chatgpt-auth-v1";
const REFRESH_WINDOW_MS = 5 * 60 * 1_000;

let refreshPromise: Promise<ChatGptAuthSession> | null = null;

export async function loadChatGptAuthSession(): Promise<ChatGptAuthSession | null> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEY);
  if (stored === null) return null;
  const session = parseStoredChatGptAuthSession(stored);
  if (session === null) await SecureStore.deleteItemAsync(STORAGE_KEY);
  return session;
}

export async function saveChatGptAuthSession(session: ChatGptAuthSession): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(session));
}

export async function clearChatGptAuthSession(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
}

export async function getValidChatGptAuthSession(
  options: {
    readonly forceRefresh?: boolean;
    readonly signal?: AbortSignal;
  } = {},
): Promise<ChatGptAuthSession | null> {
  const session = await loadChatGptAuthSession();
  if (session === null) return null;
  const shouldRefresh =
    options.forceRefresh === true ||
    (session.expiresAtMs !== null && session.expiresAtMs <= Date.now() + REFRESH_WINDOW_MS);
  if (!shouldRefresh) return session;

  refreshPromise ??= refreshChatGptAuthSession(session, { signal: options.signal })
    .then(async (refreshed) => {
      await saveChatGptAuthSession(refreshed);
      return refreshed;
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}
