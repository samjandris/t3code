import { getValidChatGptAuthSession } from "./chatgptAuthStore";
import type { ChatGptAuthSession } from "./chatgptAuth";

const CHATGPT_API_BASE_URL = "https://chatgpt.com/backend-api";
const CLEANUP_MODEL = "gpt-5.6-luna";
const CLEANUP_INSTRUCTIONS =
  "Clean up dictation transcripts. Fix likely speech recognition mistakes, punctuation, capitalization, and formatting. Remove filler words and disfluencies when they do not add meaning. When the user clearly self-corrects or backtracks, keep the corrected intent. Use surrounding text only as context. Preserve the user's meaning, wording, and flow unless a small cleanup makes the transcript more coherent. Do not answer the user or add new content. Return only the cleaned transcript.";

export class ChatGptAuthRequiredError extends Error {
  constructor() {
    super("Sign in with ChatGPT in Voice Dictation settings first.");
    this.name = "ChatGptAuthRequiredError";
  }
}

export async function transcribeAndCleanRecording(input: {
  readonly uri: string;
  readonly surroundingText: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const transcript = await withChatGptSession(
    (session) => transcribeRecording(input.uri, session, fetchImpl, input.signal),
    input.signal,
  );
  return cleanDictationTranscript({
    transcript,
    surroundingText: input.surroundingText,
    signal: input.signal,
    fetchImpl,
  });
}

export async function cleanDictationTranscript(input: {
  readonly transcript: string;
  readonly surroundingText: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
}): Promise<string> {
  const transcript = input.transcript.trim();
  if (transcript.length === 0) return "";

  try {
    return await withChatGptSession(
      (session) =>
        cleanTranscript(
          transcript,
          input.surroundingText,
          session,
          input.fetchImpl ?? fetch,
          input.signal,
        ),
      input.signal,
    );
  } catch (error) {
    if (isAbortError(error)) throw error;
    return transcript;
  }
}

export function insertDictationText(existing: string, transcript: string): string {
  const cleaned = transcript.trim();
  if (cleaned.length === 0) return existing;
  if (existing.length === 0 || /\s$/u.test(existing)) return `${existing}${cleaned}`;
  return `${existing} ${cleaned}`;
}

async function withChatGptSession<T>(
  request: (session: ChatGptAuthSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const session = await getValidChatGptAuthSession({ signal });
  if (session === null) throw new ChatGptAuthRequiredError();
  try {
    return await request(session);
  } catch (error) {
    if (!(error instanceof ChatGptRequestError) || error.status !== 401) throw error;
    const refreshed = await getValidChatGptAuthSession({ forceRefresh: true, signal });
    if (refreshed === null) throw new ChatGptAuthRequiredError();
    return request(refreshed);
  }
}

async function cleanTranscript(
  transcript: string,
  surroundingText: string,
  session: ChatGptAuthSession,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const context = surroundingText.trim().slice(0, 2_000);
  const input = `${context.length > 0 ? `Surrounding text:\n${context}\n\n` : ""}Transcript:\n${transcript.slice(0, 4_000)}`;
  const response = await fetchImpl(`${CHATGPT_API_BASE_URL}/codex/responses`, {
    method: "POST",
    headers: {
      ...authHeaders(session),
      "Content-Type": "application/json",
      "x-codex-turn-metadata": JSON.stringify({ thread_source: "dictation_cleanup" }),
    },
    body: JSON.stringify({
      model: CLEANUP_MODEL,
      instructions: CLEANUP_INSTRUCTIONS,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input }] }],
      tools: [],
      tool_choice: "none",
      parallel_tool_calls: false,
      reasoning: { effort: "low" },
      store: false,
      stream: true,
      include: [],
    }),
    signal,
  });
  if (!response.ok) throw new ChatGptRequestError("clean up", response.status);
  return parseCleanupEventStream(await response.text()) ?? transcript;
}

async function transcribeRecording(
  uri: string,
  session: ChatGptAuthSession,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<string> {
  const { File } = await import("expo-file-system");
  const form = new FormData();
  form.append("file", new File(uri), "dictation.m4a");
  const response = await fetchImpl(`${CHATGPT_API_BASE_URL}/transcribe`, {
    method: "POST",
    headers: authHeaders(session),
    body: form,
    signal,
  });
  if (!response.ok) throw new ChatGptRequestError("transcribe", response.status);
  const body = (await response.json()) as { readonly text?: unknown };
  if (typeof body.text !== "string") {
    throw new Error("ChatGPT returned an invalid transcription response.");
  }
  return body.text.trim();
}

function parseCleanupEventStream(body: string): string | null {
  const deltas: string[] = [];
  let completed: string | null = null;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      deltas.push(event.delta);
    }
    if (event.type === "response.output_text.done" && typeof event.text === "string") {
      completed = event.text;
    }
    const response = event.response;
    if (response && typeof response === "object") {
      completed = outputText(response as Record<string, unknown>) ?? completed;
    }
  }
  const result = completed ?? deltas.join("");
  return result.trim().length > 0 ? result.trim() : null;
}

function outputText(response: Record<string, unknown>): string | null {
  if (!Array.isArray(response.output)) return null;
  const text = response.output
    .flatMap((item) =>
      item && typeof item === "object" && Array.isArray((item as { content?: unknown }).content)
        ? ((item as { content: unknown[] }).content ?? [])
        : [],
    )
    .flatMap((content) =>
      content &&
      typeof content === "object" &&
      typeof (content as { text?: unknown }).text === "string"
        ? [(content as { text: string }).text]
        : [],
    )
    .join("");
  return text.length > 0 ? text : null;
}

function authHeaders(session: ChatGptAuthSession): Record<string, string> {
  return {
    Authorization: `Bearer ${session.accessToken}`,
    "ChatGPT-Account-ID": session.accountId,
    originator: "Codex Desktop",
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

class ChatGptRequestError extends Error {
  constructor(
    operation: string,
    readonly status: number,
  ) {
    super(`ChatGPT could not ${operation} the dictation (${status}).`);
    this.name = "ChatGptRequestError";
  }
}
