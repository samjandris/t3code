import { assert, describe } from "@effect/vitest";

import { createOxlintRuleHarness } from "../test/utils.ts";

const rule = createOxlintRuleHarness("t3code/no-mobile-pierre-diffs-root-import");

const mobileFilePath = "apps/mobile/src/features/review/fixture.ts";

describe("t3code/no-mobile-pierre-diffs-root-import", () => {
  rule.valid(
    "allows mobile-safe pierre diffs subpath imports",
    `
      import type { FileDiffMetadata } from "@pierre/diffs/types";
      import { getFiletypeFromFileName } from "@pierre/diffs/utils/getFiletypeFromFileName";
      import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

      export const parse = parsePatchFiles;
      export type Metadata = FileDiffMetadata;
      export const filetype = getFiletypeFromFileName;
    `,
    { filePath: mobileFilePath },
  );

  rule.valid(
    "allows web package-root imports outside mobile",
    `
      import { parsePatchFiles } from "@pierre/diffs";

      export const parse = parsePatchFiles;
    `,
    { filePath: "apps/web/src/components/fixture.ts" },
  );

  rule.invalid(
    "reports mobile package-root imports",
    `
      import { parsePatchFiles } from "@pierre/diffs";

      export const parse = parsePatchFiles;
    `,
    (output) => {
      assert.match(output, /DOM web-component code/);
    },
    { filePath: mobileFilePath },
  );

  rule.invalid(
    "reports mobile react subpath imports",
    `
      import { FileDiff } from "@pierre/diffs/react";

      export const Component = FileDiff;
    `,
    (output) => {
      assert.match(output, /mobile-safe @pierre\/diffs subpath exports/);
    },
    { filePath: mobileFilePath },
  );
});
