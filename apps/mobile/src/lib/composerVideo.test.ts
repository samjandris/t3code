import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  getVideoCompressionState,
  isVideoCompressing,
  subscribeVideoCompression,
  withComposerVideo,
} from "./composerVideo";
import { isForegroundHandoffActive } from "./foreground-handoff";

const mocks = vi.hoisted(() => ({
  sizes: new Map<string, number | null>(),
  compress: vi.fn(),
  metadata: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("./uuid", () => ({ uuidv4: () => "compression-id" }));
vi.mock("react-native-compressor", () => ({
  Video: { compress: mocks.compress, cancelCompression: mocks.cancel },
  getVideoMetaData: mocks.metadata,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get size() {
      return mocks.sizes.get(this.uri) ?? null;
    }
    get exists() {
      return mocks.sizes.has(this.uri);
    }
    delete() {
      mocks.remove(this.uri);
      mocks.sizes.delete(this.uri);
    }
  },
}));
const input = {
  uri: "file:///original.mov",
  name: "clip.mov",
  mimeType: "video/quicktime",
  maxBytes: 1000,
};

describe("video attachment compression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compress.mockReset();
    mocks.metadata.mockReset().mockRejectedValue(new Error("metadata unavailable"));
    mocks.sizes.clear();
    mocks.sizes.set(input.uri, 2000);
  });
  it("blocks submission through encoding and persistence, then notifies that it is ready", async () => {
    const encoding = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const persisted = Promise.withResolvers<void>();
    const consuming = Promise.withResolvers<void>();
    const states: boolean[] = [];
    const unsubscribe = subscribeVideoCompression(() => states.push(isVideoCompressing()));
    mocks.sizes.set("file:///compressed.mp4", 800);
    mocks.compress.mockImplementation(() => {
      started.resolve();
      return encoding.promise;
    });
    try {
      expect(isVideoCompressing()).toBe(false);
      const result = withComposerVideo(input, async () => {
        consuming.resolve();
        await persisted.promise;
        return "ready";
      });
      await started.promise;
      expect(getVideoCompressionState()?.attachment).toMatchObject({
        id: "compression-id",
        fileUri: input.uri,
        name: input.name,
      });
      expect(isVideoCompressing()).toBe(true);
      encoding.resolve("file:///compressed.mp4");
      await consuming.promise;
      expect(isVideoCompressing()).toBe(true);
      persisted.resolve();
      expect(await result).toBe("ready");
      expect(isVideoCompressing()).toBe(false);
      expect(states[0]).toBe(true);
      expect(states.at(-1)).toBe(false);
      expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("file:///compressed.mp4");
    } finally {
      unsubscribe();
    }
  });
  it("preserves a video already under the limit without loading the encoder", async () => {
    mocks.sizes.set(input.uri, 500);
    const consume = vi.fn(async (file) => file);
    expect(await withComposerVideo(input, consume)).toMatchObject({
      uri: input.uri,
      sizeBytes: 500,
    });
    expect(mocks.compress).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("copies a smaller MP4 before deleting only its temporary output", async () => {
    mocks.sizes.set("file:///compressed.mp4", 800);
    mocks.compress.mockResolvedValue("file:///compressed.mp4");
    const result = await withComposerVideo(input, async (file) => {
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(isForegroundHandoffActive()).toBe(true);
      return file;
    });
    expect(result).toEqual({
      uri: "file:///compressed.mp4",
      name: "clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 800,
      compressionId: "compression-id",
    });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("file:///compressed.mp4");
    expect(mocks.sizes.has(input.uri)).toBe(true);
    expect(getVideoCompressionState()).toBeNull();
    expect(isForegroundHandoffActive()).toBe(false);
  });
  it("retries from the original at lower quality, releasing the first output", async () => {
    mocks.sizes.set("file:///large.mp4", 1100);
    mocks.sizes.set("file:///small.mp4", 600);
    mocks.compress
      .mockResolvedValueOnce("file:///large.mp4")
      .mockResolvedValueOnce("file:///small.mp4");
    expect(await withComposerVideo(input, async (file) => file.sizeBytes)).toBe(600);
    expect(mocks.compress.mock.calls.map((call) => call[0])).toEqual([input.uri, input.uri]);
    expect(mocks.remove.mock.calls.flat()).toEqual(["file:///large.mp4", "file:///small.mp4"]);
  });
  it("uses 90% of the compression range for the first attempt and finishes after validation", async () => {
    mocks.sizes.set("file:///fits.mp4", 800);
    mocks.compress.mockImplementation(async (_uri, _options, progress) => {
      progress(0.5);
      expect(getVideoCompressionState()?.progress).toBe(0.45);
      progress(1);
      expect(getVideoCompressionState()?.progress).toBe(0.9);
      return "file:///fits.mp4";
    });
    await withComposerVideo(input, async () => {
      expect(getVideoCompressionState()?.progress).toBe(1);
    });
    expect(mocks.compress).toHaveBeenCalledTimes(1);
  });
  it("keeps tile progress monotonic through a second compression pass", async () => {
    mocks.sizes.set("file:///large.mp4", 1100);
    mocks.sizes.set("file:///small.mp4", 600);
    const updates: number[] = [];
    const unsubscribe = subscribeVideoCompression(() => {
      const state = getVideoCompressionState();
      if (state) updates.push(state.progress);
    });
    mocks.compress
      .mockImplementationOnce(async (_uri, _options, progress) => {
        progress(0.8);
        progress(1);
        expect(getVideoCompressionState()?.progress).toBe(0.9);
        return "file:///large.mp4";
      })
      .mockImplementationOnce(async (_uri, _options, progress) => {
        progress(0.2);
        const early = getVideoCompressionState()!.progress;
        expect(early).toBeGreaterThan(0.9);
        progress(0.9);
        expect(getVideoCompressionState()!.progress).toBeGreaterThan(early);
        expect(getVideoCompressionState()!.progress).toBeLessThan(1);
        return "file:///small.mp4";
      });
    try {
      const result = await withComposerVideo({ ...input, ownerKey: "thread-1" }, async (file) => {
        expect(getVideoCompressionState()?.ownerKey).toBe("thread-1");
        expect(file.compressionId).toBe(getVideoCompressionState()?.attachment.id);
        return file;
      });
      expect(result.uri).toBe("file:///small.mp4");
      expect(updates.length).toBeGreaterThan(2);
      expect(updates).toEqual([...updates].sort((a, b) => a - b));
      expect(updates.at(-1)).toBe(1);
    } finally {
      unsubscribe();
    }
  });
  it("rejects a still oversized video after bounded attempts without deleting the source", async () => {
    mocks.sizes.set("file:///large.mp4", 1100);
    mocks.compress.mockImplementation(async () => {
      mocks.sizes.set("file:///large.mp4", 1100);
      return "file:///large.mp4";
    });
    const consume = vi.fn();
    await expect(withComposerVideo(input, consume)).rejects.toThrow("Trim the video");
    expect(mocks.compress).toHaveBeenCalledTimes(4);
    expect(consume).not.toHaveBeenCalled();
    expect(mocks.sizes.has(input.uri)).toBe(true);
  });
  it("does not delete a source returned by a native no-op", async () => {
    mocks.compress.mockResolvedValue(input.uri);
    await expect(withComposerVideo(input, vi.fn())).rejects.toThrow("Trim the video");
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("releases compressed output even when persisting the draft fails", async () => {
    mocks.sizes.set("file:///compressed.mp4", 800);
    mocks.compress.mockResolvedValue("file:///compressed.mp4");
    await expect(
      withComposerVideo(input, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("file:///compressed.mp4");
    expect(getVideoCompressionState()).toBeNull();
  });
  it("cancels native work and never consumes a late result", async () => {
    mocks.sizes.set("file:///compressed.mp4", 800);
    mocks.compress.mockImplementation(async (_uri, options, progress) => {
      options.getCancellationId("job");
      progress(0.5);
      expect(getVideoCompressionState()?.progress).toBe(0.45);
      getVideoCompressionState()?.cancel();
      return "file:///compressed.mp4";
    });
    const consume = vi.fn();
    await expect(withComposerVideo(input, consume)).rejects.toThrow("cancelled");
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith("job");
    expect(consume).not.toHaveBeenCalled();
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith("file:///compressed.mp4");
    expect(getVideoCompressionState()).toBeNull();
  });
  it("clears progress and the handoff guard after an encoder failure", async () => {
    mocks.compress.mockRejectedValue(new Error("unsupported codec"));
    await expect(withComposerVideo(input, vi.fn())).rejects.toThrow("unsupported codec");
    expect(getVideoCompressionState()).toBeNull();
    expect(isForegroundHandoffActive()).toBe(false);
  });
});

describe("video quality selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compress.mockReset();
    mocks.metadata
      .mockReset()
      .mockResolvedValue({ width: 3840, height: 2160, duration: 30, compressionCodec: "hevc" });
    mocks.sizes.clear();
    mocks.sizes.set(input.uri, 75 * 1024 * 1024);
  });
  it("keeps original resolution first and targets the size budget", async () => {
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockResolvedValue("file:///fits.mp4");
    await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    expect(mocks.compress).toHaveBeenCalledTimes(1);
    expect(mocks.compress.mock.calls[0]?.[1]).toMatchObject({ maxSize: 3840, bitrate: 12_454_912 });
  });
  it("reduces bitrate within a resolution until its pixel budget requires a smaller size", async () => {
    mocks.compress.mockImplementation(async () => {
      mocks.sizes.set("file:///large.mp4", 60 * 1024 * 1024);
      return "file:///large.mp4";
    });
    await expect(
      withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, vi.fn()),
    ).rejects.toThrow("Trim the video");
    const options = mocks.compress.mock.calls.map((call) => call[1]);
    expect(options.map((option) => option.maxSize)).toEqual([3840, 3840, 1920, 1920, 1280]);
    expect(options.map((option) => option.bitrate)).toEqual([
      12_454_912, 6_227_456, 3_113_728, 1_556_864, 778_432,
    ]);
    expect(mocks.compress.mock.calls.every((call) => call[0] === input.uri)).toBe(true);
    expect(mocks.remove).toHaveBeenCalledTimes(5);
    expect(mocks.sizes.has(input.uri)).toBe(true);
  });
  it("starts a long 4K video at 1080p when the upload budget cannot support 4K", async () => {
    mocks.metadata.mockResolvedValue({
      width: 3840,
      height: 2160,
      duration: 120,
      compressionCodec: "hevc",
    });
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockResolvedValue("file:///fits.mp4");
    await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    expect(mocks.compress.mock.calls[0]?.[1]).toMatchObject({ maxSize: 1920, bitrate: 3_017_728 });
  });
  it("uses the same pixel budget for portrait video", async () => {
    mocks.metadata.mockResolvedValue({
      width: 2160,
      height: 3840,
      duration: 120,
      compressionCodec: "hevc",
    });
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockResolvedValue("file:///fits.mp4");
    await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    expect(mocks.compress.mock.calls[0]?.[1]).toMatchObject({ maxSize: 1920, bitrate: 3_017_728 });
  });
  it("permits a lower HEVC bitrate at small dimensions", async () => {
    mocks.metadata.mockResolvedValue({
      width: 3840,
      height: 2160,
      duration: 3600,
      compressionCodec: "hevc",
    });
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockResolvedValue("file:///fits.mp4");
    await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    expect(mocks.compress.mock.calls[0]?.[1]).toMatchObject({ maxSize: 640, bitrate: 150_000 });
  });
  it("keeps a more conservative pixel budget without HEVC support", async () => {
    mocks.metadata.mockResolvedValue({
      width: 3840,
      height: 2160,
      duration: 60,
      compressionCodec: "h264",
    });
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockResolvedValue("file:///fits.mp4");
    await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    expect(mocks.compress.mock.calls[0]?.[1]).toMatchObject({ maxSize: 1920 });
  });
  it("requires more bitrate to retain 4K at 60 fps than at 30 fps", async () => {
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockImplementation(async () => {
      mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
      return "file:///fits.mp4";
    });
    for (const frameRate of [30, 60]) {
      mocks.metadata.mockResolvedValue({
        width: 3840,
        height: 2160,
        duration: 60,
        compressionCodec: "hevc",
        frameRate,
      });
      await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    }
    expect(mocks.compress.mock.calls.map((call) => call[1].maxSize)).toEqual([3840, 1920]);
    expect(mocks.compress.mock.calls[0]?.[1].bitrate).toBe(
      mocks.compress.mock.calls[1]?.[1].bitrate,
    );
  });
  it.each([
    [23.976, 3840],
    [29.97, 3840],
    [59.94, 1920],
    [120, 1920],
  ])("accepts %s fps without rounding it to a preset", async (frameRate, maxSize) => {
    mocks.metadata.mockResolvedValue({
      width: 3840,
      height: 2160,
      duration: 60,
      compressionCodec: "hevc",
      frameRate,
    });
    mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
    mocks.compress.mockResolvedValue("file:///fits.mp4");
    await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
    expect(mocks.compress.mock.calls[0]?.[1].maxSize).toBe(maxSize);
  });
  it.each([undefined, 0, -1, NaN, Infinity])(
    "uses 30 fps when frame rate is invalid: %s",
    async (frameRate) => {
      mocks.metadata.mockResolvedValue({
        width: 3840,
        height: 2160,
        duration: 60,
        compressionCodec: "hevc",
        frameRate,
      });
      mocks.sizes.set("file:///fits.mp4", 45 * 1024 * 1024);
      mocks.compress.mockResolvedValue("file:///fits.mp4");
      await withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, async (file) => file);
      expect(mocks.compress.mock.calls[0]?.[1].maxSize).toBe(3840);
    },
  );
  it("does not upscale small videos or retry an identical bitrate and resolution", async () => {
    mocks.metadata.mockResolvedValue({ width: 640, height: 360, duration: 3600 });
    mocks.compress.mockImplementation(async () => {
      mocks.sizes.set("file:///large.mp4", 60 * 1024 * 1024);
      return "file:///large.mp4";
    });
    await expect(
      withComposerVideo({ ...input, maxBytes: 50 * 1024 * 1024 }, vi.fn()),
    ).rejects.toThrow("Trim the video");
    expect(mocks.compress).toHaveBeenCalledTimes(1);
    expect(mocks.compress.mock.calls[0]?.[1]).toMatchObject({ maxSize: 640, bitrate: 250_000 });
  });
});
