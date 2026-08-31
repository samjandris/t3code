import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

const files = new Map<string, { base64: string; deleted: boolean }>();
const imagePickerMocks = vi.hoisted(() => ({
  launchImageLibraryAsync: vi.fn(),
}));
const imageManipulatorMocks = vi.hoisted(() => {
  const image = {
    release: vi.fn(),
    saveAsync: vi.fn(),
  };
  const context = {
    release: vi.fn(),
    renderAsync: vi.fn(() => Promise.resolve(image)),
    resize: vi.fn(),
  };
  return {
    context,
    image,
    manipulate: vi.fn(() => context),
  };
});

vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: imagePickerMocks.launchImageLibraryAsync,
  UIImagePickerPreferredAssetRepresentationMode: {
    Compatible: "compatible",
  },
}));

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: {
    manipulate: imageManipulatorMocks.manipulate,
  },
  SaveFormat: {
    JPEG: "jpeg",
  },
}));

vi.mock("./foreground-handoff", () => ({
  beginForegroundHandoff: () => () => undefined,
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;

    constructor(uri: string) {
      this.uri = uri;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  },
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  isOwnedPastedImageUri,
  pickComposerImages,
} from "./composerImages";

describe("pickComposerImages", () => {
  beforeEach(() => {
    imagePickerMocks.launchImageLibraryAsync.mockReset();
    imageManipulatorMocks.manipulate.mockClear();
    imageManipulatorMocks.context.release.mockClear();
    imageManipulatorMocks.context.renderAsync.mockClear();
    imageManipulatorMocks.context.resize.mockClear();
    imageManipulatorMocks.image.release.mockClear();
    imageManipulatorMocks.image.saveAsync.mockReset();
    files.clear();
  });

  it("compresses and resizes picker output that exceeds the attachment limit", async () => {
    const oversizedJpeg = `/9j/${"A".repeat(14_000_000)}`;
    const compressedJpeg = "/9j/AAAA";
    const oversizedTemporaryUri = "file:///cache/oversized.jpg";
    const compressedTemporaryUri = "file:///cache/compressed.jpg";
    files.set(oversizedTemporaryUri, { base64: oversizedJpeg, deleted: false });
    files.set(compressedTemporaryUri, { base64: compressedJpeg, deleted: false });
    imagePickerMocks.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          base64: oversizedJpeg,
          fileName: "large.HEIC",
          height: 6048,
          mimeType: "image/heic",
          uri: "file:///photos/large.HEIC",
          width: 8064,
        },
      ],
    });
    imageManipulatorMocks.image.saveAsync
      .mockResolvedValueOnce({
        base64: oversizedJpeg,
        height: 3072,
        uri: oversizedTemporaryUri,
        width: 4096,
      })
      .mockResolvedValueOnce({
        base64: compressedJpeg,
        height: 3072,
        uri: compressedTemporaryUri,
        width: 4096,
      });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(imagePickerMocks.launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({ preferredAssetRepresentationMode: "compatible" }),
    );
    expect(imageManipulatorMocks.manipulate).toHaveBeenCalledWith("file:///photos/large.HEIC");
    expect(imageManipulatorMocks.context.resize).toHaveBeenCalledWith({
      width: 4096,
      height: null,
    });
    expect(imageManipulatorMocks.image.saveAsync).toHaveBeenNthCalledWith(1, {
      base64: true,
      compress: 0.85,
      format: "jpeg",
    });
    expect(imageManipulatorMocks.image.saveAsync).toHaveBeenNthCalledWith(2, {
      base64: true,
      compress: 0.7,
      format: "jpeg",
    });
    expect(imageManipulatorMocks.context.release).toHaveBeenCalledOnce();
    expect(imageManipulatorMocks.image.release).toHaveBeenCalledOnce();
    expect(files.get(oversizedTemporaryUri)?.deleted).toBe(true);
    expect(files.get(compressedTemporaryUri)?.deleted).toBe(true);
    expect(result).toEqual({
      images: [
        expect.objectContaining({
          dataUrl: `data:image/jpeg;base64,${compressedJpeg}`,
          mimeType: "image/jpeg",
          name: "large.jpg",
          sizeBytes: 6,
        }),
      ],
      error: null,
    });
  });

});

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
  });

  it("recognizes only files created in the native composer paste directory", () => {
    expect(
      isOwnedPastedImageUri(
        "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png",
      ),
    ).toBe(true);
    expect(isOwnedPastedImageUri("file:///private/var/mobile/photos/id.png")).toBe(false);
    expect(isOwnedPastedImageUri("https://example.com/t3-composer-paste/id.png")).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });
});
