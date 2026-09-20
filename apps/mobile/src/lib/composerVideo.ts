import { uuidv4 } from "./uuid";
import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import { beginForegroundHandoff } from "./foreground-handoff";

type CompressionState = {
  readonly attachment: {
    readonly id: string;
    readonly type: "file";
    readonly name: string;
    readonly mimeType: string;
    readonly fileUri: string;
    readonly sizeBytes: number;
  };
  readonly ownerKey?: string | undefined;
  readonly progress: number;
  readonly cancel: () => void;
} | null;

let state: CompressionState = null;
const listeners = new Set<() => void>();
export const getVideoCompressionState = () => state;
export const isVideoCompressing = () => state !== null;
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

const fallbackStages = [
  { maxSize: 1920, bitrate: 4_000_000 },
  { maxSize: 1280, bitrate: 2_000_000 },
  { maxSize: 854, bitrate: 1_000_000 },
  { maxSize: 854, bitrate: 500_000 },
] as const;

function compressionStages(
  metadata: {
    width: number;
    height: number;
    duration: number;
    frameRate?: number;
    compressionCodec?: string;
  } | null,
  sourceBytes: number | null,
  maxBytes: number,
) {
  if (
    !metadata ||
    ![metadata.width, metadata.height, metadata.duration].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  )
    return fallbackStages;
  const longSide = Math.ceil(Math.max(metadata.width, metadata.height));
  // Reserve container overhead and the encoder's 128 kbps audio track. Start
  // near the upload budget instead of guessing a small fixed bitrate for every clip.
  const budget = (maxBytes * 8 * 0.9) / metadata.duration - 128_000;
  const sourceRate =
    sourceBytes && sourceBytes > 0 ? (sourceBytes * 8) / metadata.duration : Infinity;
  const minimumBitrate = metadata.compressionCodec === "hevc" ? 150_000 : 250_000;
  const frameRate =
    metadata.frameRate !== undefined &&
    Number.isFinite(metadata.frameRate) &&
    metadata.frameRate > 0
      ? metadata.frameRate
      : 30;
  const bitsPerPixelPerFrame = metadata.compressionCodec === "hevc" ? 1 / 60 : 1 / 30;
  const initialBitrate = Math.max(
    minimumBitrate,
    Math.floor(Math.min(budget, sourceRate * 0.9, 40_000_000)),
  );
  // Scale the quality floor by pixel count and source frame rate. Choose
  // dimensions from the bitrate on EVERY attempt, including the first, so a
  // long 4K recording does not get encoded at a bitrate meant for 720p.
  const sourcePixels = metadata.width * metadata.height;
  const dimensions = [longSide, 1920, 1280, 854, 640, 426].filter((size) => size <= longSide);
  return Array.from({ length: 5 }, (_, index) => {
    const bitrate = Math.max(minimumBitrate, Math.floor(initialBitrate / 2 ** index));
    const maxSize =
      dimensions.find(
        (size) =>
          sourcePixels * (size / longSide) ** 2 * frameRate * bitsPerPixelPerFrame <= bitrate,
      ) ?? dimensions[dimensions.length - 1]!;
    return { maxSize, bitrate };
  }).filter(
    (stage, index, stages) =>
      index === 0 ||
      stage.maxSize !== stages[index - 1]!.maxSize ||
      stage.bitrate !== stages[index - 1]!.bitrate,
  );
}

/** Only the native encoder touches video bytes. The caller must copy the result before returning. */
export async function withComposerVideo<T>(
  input: {
    readonly uri: string;
    readonly name: string;
    readonly mimeType: string;
    readonly maxBytes: number;
    readonly ownerKey?: string | undefined;
  },
  consume: (file: {
    uri: string;
    name: string;
    mimeType: string;
    sizeBytes: number | null;
    compressionId?: string;
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

  const attachment: NonNullable<CompressionState>["attachment"] = {
    id: uuidv4(),
    type: "file",
    name: input.name,
    mimeType: input.mimeType,
    fileUri: input.uri,
    sizeBytes: sourceSize ?? 0,
  };
  let progressSoFar = 0;
  function report(progress: number) {
    progressSoFar = Math.max(progressSoFar, Math.max(0, Math.min(1, progress)));
    publish({ attachment, ownerKey: input.ownerKey, progress: progressSoFar, cancel });
  }
  let cancelled = false;
  let cancelNative = () => {};
  const cancel = () => {
    cancelled = true;
    cancelNative();
  };
  const endHandoff = beginForegroundHandoff();
  report(0);
  try {
    const { Video, getVideoMetaData } = await import("react-native-compressor");
    const metadata = await getVideoMetaData(input.uri).catch(() => null);
    const stages = compressionStages(metadata, sourceSize, input.maxBytes);
    for (const [attempt, stage] of stages.entries()) {
      if (cancelled) throw new Error("Video compression cancelled.");
      report(0);
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
            // The first encode gets 0 to 45% overall; retries share 45 to 50%.
            // Reserve completion for a file that passes the actual size check.
            const fraction = Math.max(0, Math.min(1, progress));
            const overall =
              attempt === 0
                ? fraction * 0.9
                : 0.9 + (0.1 * (attempt - 1 + fraction)) / (stages.length - 1);
            if (!cancelled) report(Math.min(overall, 0.99));
          },
        );
        const output = new File(result);
        // A native no-op can return the source. Never delete that file.
        if (output.uri === source.uri) break;
        outputUri = output.uri;
        if (cancelled) throw new Error("Video compression cancelled.");
        const size = output.size;
        if (size !== null && size > 0 && size <= input.maxBytes) {
          report(1);
          return await consume({
            uri: output.uri,
            name: `${input.name.replace(/\.[^./]+$/, "") || "video"}.mp4`,
            mimeType: "video/mp4",
            sizeBytes: size,
            compressionId: attachment.id,
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
