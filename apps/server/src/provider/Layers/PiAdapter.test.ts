import { assert, describe, it } from "@effect/vitest";

import { textDeltaFromPiPayload } from "./PiAdapter.ts";

describe("PiAdapter", () => {
  it("extracts documented Pi message_update text deltas", () => {
    assert.equal(
      textDeltaFromPiPayload({
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "Hello from Pi",
        },
      }),
      "Hello from Pi",
    );
  });

  it("preserves whitespace in streamed text deltas", () => {
    assert.equal(
      textDeltaFromPiPayload({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: " world ",
        },
      }),
      " world ",
    );
  });

  it("ignores non-text Pi message_update deltas", () => {
    assert.equal(
      textDeltaFromPiPayload({
        type: "message_update",
        message: {},
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 0,
          delta: "internal thought",
        },
      }),
      undefined,
    );
  });
});
