import * as Schema from "effect/Schema";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import { getValidChatGptAuthSession } from "./chatgptAuthStore";
import { ChatGptAuthRequiredError, transcribeAndCleanRecording } from "./chatgptDictationClient";

const isChatGptAuthRequiredError = Schema.is(ChatGptAuthRequiredError);

export function getChatGptVoiceTranscriber(surroundingText: string): VoiceTranscriber {
  return {
    prepare: async (options) => {
      throwIfVoiceTranscriptionAborted(options.signal);
      const session = await getValidChatGptAuthSession({ signal: options.signal });
      throwIfVoiceTranscriptionAborted(options.signal);

      if (session === null) {
        throw new VoiceTranscriptionError({
          code: "unavailable",
          message: "Sign in to ChatGPT in Settings > Voice > ChatGPT account first.",
        });
      }

      return {
        locale: "auto",
        transcribe: async (uri, transcriptionOptions) => {
          try {
            return await transcribeAndCleanRecording({
              uri,
              surroundingText,
              signal: transcriptionOptions.signal,
            });
          } catch (error) {
            throwIfVoiceTranscriptionAborted(transcriptionOptions.signal);
            if (isChatGptAuthRequiredError(error)) {
              throw new VoiceTranscriptionError({
                code: "unavailable",
                message: "Sign in to ChatGPT in Settings > Voice > ChatGPT account first.",
                cause: error,
              });
            }
            throw new VoiceTranscriptionError({
              code: "transcription-failed",
              message: error instanceof Error ? error.message : "ChatGPT voice dictation failed.",
              cause: error,
            });
          }
        },
      };
    },
  };
}
