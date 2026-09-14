import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { getValidChatGptAuthSession } from "./chatgptAuthStore";
import { ChatGptAuthRequiredError, transcribeAndCleanRecording } from "./chatgptDictationClient";

export function getChatGptVoiceTranscriber(
  surroundingText: string,
  localFallback: VoiceTranscriber | null,
): VoiceTranscriber {
  return {
    prepare: async (options) => {
      throwIfVoiceTranscriptionAborted(options.signal);
      const session = await getValidChatGptAuthSession({ signal: options.signal });
      throwIfVoiceTranscriptionAborted(options.signal);

      if (session === null) {
        if (localFallback) return localFallback.prepare(options);
        throw new VoiceTranscriptionError(
          "unavailable",
          "Sign in with ChatGPT in Voice Dictation settings first.",
        );
      }

      return {
        locale: Intl.DateTimeFormat().resolvedOptions().locale,
        transcribe: async (uri, transcriptionOptions) => {
          try {
            return await transcribeAndCleanRecording({
              uri,
              surroundingText,
              signal: transcriptionOptions.signal,
            });
          } catch (error) {
            throwIfVoiceTranscriptionAborted(transcriptionOptions.signal);
            if (error instanceof ChatGptAuthRequiredError) {
              throw new VoiceTranscriptionError(
                "unavailable",
                "Sign in with ChatGPT in Voice Dictation settings first.",
                { cause: error },
              );
            }
            throw new VoiceTranscriptionError(
              "transcription-failed",
              error instanceof Error ? error.message : "ChatGPT voice dictation failed.",
              { cause: error },
            );
          }
        },
      };
    },
  };
}
