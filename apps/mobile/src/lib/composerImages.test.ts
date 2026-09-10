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

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(root: string | { readonly uri: string }, name: string) {
      this.uri = `${typeof root === "string" ? root : root.uri}/${name}`;
    }

    create(): void {}
  }

  class File {
    readonly uri: string;

    constructor(source: string | Directory, name?: string) {
      this.uri = source instanceof Directory ? `${source.uri}/${name}` : source;
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    get size(): number | null {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        return null;
      }
      return Buffer.from(entry.base64, "base64").byteLength;
    }

    create(): void {}

    write(base64: string): void {
      files.set(this.uri, { base64, deleted: false });
    }

    async copy(destination: File): Promise<void> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      files.set(destination.uri, { base64: entry.base64, deleted: false });
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }
  }

  return {
    Directory,
    File,
    FileMode: { ReadOnly: "r", WriteOnly: "w" },
    Paths: { document: { uri: "file:///documents" } },
  };
});

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

  it.each(["image/heic", "image/jpeg"])(
    "compresses oversized %s into a file-backed draft",
    async (mimeType) => {
      const oversizedJpeg = `/9j/${"A".repeat(14_000_000)}`;
      const compressedJpeg = "/9j/AAAA";
      const oversizedTemporaryUri = "file:///cache/oversized.jpg";
      const compressedTemporaryUri = "file:///cache/compressed.jpg";
      files.set(oversizedTemporaryUri, { base64: oversizedJpeg, deleted: false });
      files.set(compressedTemporaryUri, { base64: compressedJpeg, deleted: false });
      files.set("file:///photos/large.HEIC", { base64: oversizedJpeg, deleted: false });
      imagePickerMocks.launchImageLibraryAsync.mockResolvedValue({
        canceled: false,
        assets: [
          {
            base64: oversizedJpeg,
            fileName: "large.HEIC",
            height: 6048,
            mimeType,
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
            fileUri: "file:///documents/t3-composer-attachments/attachment-id-large.jpg",
            previewUri: "file:///documents/t3-composer-attachments/attachment-id-large.jpg",
            mimeType: "image/jpeg",
            name: "large.jpg",
            sizeBytes: 6,
          }),
        ],
        error: null,
      });
      expect(result.images[0]).not.toHaveProperty("dataUrl");
      expect(JSON.stringify(result.images).length).toBeLessThan(1024);
      expect(files.get(result.images[0]!.fileUri!)?.base64).toBe(compressedJpeg);
    },
  );
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

  it("copies owned files into durable storage without inlining bytes, deleting the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const attachments = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    const fileUri = "file:///documents/t3-composer-attachments/attachment-id-pasted-image.png";
    expect(attachments).toEqual([
      {
        id: "attachment-id",
        type: "image",
        name: "pasted-image.png",
        mimeType: "image/png",
        sizeBytes: 5,
        fileUri,
        previewUri: fileUri,
      },
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
    expect(files.get(fileUri)?.deleted).toBe(false);
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
    // The rejected paste's partial durable copy must not leak either.
    expect(
      files.get("file:///documents/t3-composer-attachments/attachment-id-pasted-image.png")
        ?.deleted,
    ).toBe(true);
  });
});
