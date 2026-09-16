import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import { beginForegroundHandoff } from "./foreground-handoff";

type CompressionState = {
  readonly name: string;
  readonly progress: number;
  readonly attempt: number;
  readonly cancel: () => void;
} | null;

let state: CompressionState = null;
const listeners = new Set<() => void>();
export const getVideoCompressionState = () => state;
export function subscribeVideoCompression(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function publish(next: CompressionState) {
  state = next;
  for (const listener of listeners) listener();
}

const stages = [
  { maxSize: 1280, bitrate: 1_500_000 },
  { maxSize: 854, bitrate: 500_000 },
] as const;

/** Only the native encoder touches video bytes. The caller must copy the result before returning. */
export async function withComposerVideo<T>(
  input: {
    readonly uri: string;
    readonly name: string;
    readonly mimeType: string;
    readonly maxBytes: number;
  },
  consume: (file: {
    uri: string;
    name: string;
    mimeType: string;
    sizeBytes: number | null;
  }) => Promise<T>,
): Promise<T> {
  const { File } = await import("expo-file-system");
  const source = new File(input.uri);
  const sourceSize = source.size;
  if (sourceSize !== null && sourceSize >= 0 && sourceSize <= input.maxBytes) {
    return consume({ ...input, sizeBytes: sourceSize });
  }
  if (state !== null)
    throw new Error("Another video is being compressed. Try again when it finishes.");

  let cancelled = false;
  let cancelNative = () => {};
  const cancel = () => {
    cancelled = true;
    cancelNative();
  };
  const endHandoff = beginForegroundHandoff();
  publish({ name: input.name, progress: 0, attempt: 1, cancel });
  try {
    const { Video } = await import("react-native-compressor");
    for (const [index, stage] of stages.entries()) {
      if (cancelled) throw new Error("Video compression cancelled.");
      publish({ name: input.name, progress: 0, attempt: index + 1, cancel });
      let outputUri: string | undefined;
      try {
        const result = await Video.compress(
          input.uri,
          {
            ...stage,
            compressionMethod: "manual",
            minimumFileSizeForCompress: 0,
            progressDivider: 5,
            getCancellationId: (id) => {
              cancelNative = () => Video.cancelCompression(id);
              if (cancelled) cancelNative();
            },
          },
          (progress) => {
            if (!cancelled) publish({ name: input.name, progress, attempt: index + 1, cancel });
          },
        );
        const output = new File(result);
        // A native no-op can return the source. Never delete that file.
        if (output.uri === source.uri) break;
        outputUri = output.uri;
        if (cancelled) throw new Error("Video compression cancelled.");
        const size = output.size;
        if (size !== null && size > 0 && size <= input.maxBytes) {
          return await consume({
            uri: output.uri,
            name: `${input.name.replace(/\.[^./]+$/, "") || "video"}.mp4`,
            mimeType: "video/mp4",
            sizeBytes: size,
          });
        }
      } finally {
        cancelNative = () => {};
        if (outputUri) {
          try {
            const file = new File(outputUri);
            if (file.exists) file.delete();
          } catch (error) {
            console.warn("Could not remove compressed video", error);
          }
        }
      }
    }
    throw new Error(
      `${fileAttachmentTooLargeMessage(input.name, input.maxBytes)} Trim the video and try again.`,
    );
  } catch (error) {
    if (cancelled) throw new Error("Video compression cancelled.", { cause: error });
    throw error;
  } finally {
    publish(null);
    endHandoff();
  }
}
