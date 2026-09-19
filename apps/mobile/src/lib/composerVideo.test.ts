import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { getVideoCompressionState, withComposerVideo } from "./composerVideo";
import { isForegroundHandoffActive } from "./foreground-handoff";

const mocks = vi.hoisted(() => ({
  sizes: new Map<string, number | null>(),
  compress: vi.fn(),
  cancel: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("react-native-compressor", () => ({
  Video: { compress: mocks.compress, cancelCompression: mocks.cancel },
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
    mocks.sizes.clear();
    mocks.sizes.set(input.uri, 2000);
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
  it("rejects a still oversized video after two attempts without deleting the source", async () => {
    mocks.sizes.set("file:///large.mp4", 1100);
    mocks.compress.mockImplementation(async () => {
      mocks.sizes.set("file:///large.mp4", 1100);
      return "file:///large.mp4";
    });
    const consume = vi.fn();
    await expect(withComposerVideo(input, consume)).rejects.toThrow("Trim the video");
    expect(mocks.compress).toHaveBeenCalledTimes(2);
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
      expect(getVideoCompressionState()?.progress).toBe(0.5);
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
