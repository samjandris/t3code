import { definePlugin } from "@oxlint/plugins";

import noInlineSchemaCompile from "./rules/no-inline-schema-compile.ts";
import noMobilePierreDiffsRootImport from "./rules/no-mobile-pierre-diffs-root-import.ts";

export default definePlugin({
  meta: {
    name: "t3code",
  },
  rules: {
    "no-inline-schema-compile": noInlineSchemaCompile,
    "no-mobile-pierre-diffs-root-import": noMobilePierreDiffsRootImport,
  },
});
