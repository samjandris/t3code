import { describe, expect, it } from "vitest";

import { buildPairingUrl, extractPairingUrlFromQrPayload, parsePairingUrl } from "./pairing";

describe("extractPairingUrlFromQrPayload", () => {
  it("trims raw pairing urls from qr payloads", () => {
    expect(
      extractPairingUrlFromQrPayload("  https://remote.example.com/pair#token=pairing-token  "),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("unwraps mobile deep links that carry an encoded pairing url", () => {
    expect(
      extractPairingUrlFromQrPayload(
        "t3code://pair?pairingUrl=https%3A%2F%2Fremote.example.com%2Fpair%23token%3Dpairing-token",
      ),
    ).toBe("https://remote.example.com/pair#token=pairing-token");
  });

  it("rejects empty qr payloads", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrow(
      "Scanned QR code did not contain a pairing URL.",
    );
  });
});

describe("parsePairingUrl", () => {
  it("extracts host and code from direct backend pairing urls", () => {
    expect(parsePairingUrl("https://remote.example.com:3773/pair#token=pairing-token")).toEqual({
      host: "https://remote.example.com:3773",
      code: "pairing-token",
    });
  });

  it("unwraps hosted app pairing urls", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://remote.example.com",
      code: "pairing-token",
    });
  });

  it("keeps hosted backend ports when unwrapping hosted app pairing urls", () => {
    expect(
      parsePairingUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fremote.example.com%3A8443%2F#token=pairing-token",
      ),
    ).toEqual({
      host: "https://remote.example.com:8443",
      code: "pairing-token",
    });
  });
});

describe("buildPairingUrl", () => {
  it("rebuilds pairing urls from host and code fields", () => {
    expect(buildPairingUrl("https://remote.example.com", "pairing-token")).toBe(
      "https://remote.example.com/#token=pairing-token",
    );
  });
});
