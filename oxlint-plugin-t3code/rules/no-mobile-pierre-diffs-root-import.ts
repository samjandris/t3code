import { defineRule } from "@oxlint/plugins";
import type { Ranged } from "@oxlint/plugins";

const MOBILE_SOURCE_MARKER = "/apps/mobile/src/";
const PIERRE_DIFFS_PACKAGE = "@pierre/diffs";
const ALLOWED_MOBILE_IMPORTS = new Set([
  "@pierre/diffs/types",
  "@pierre/diffs/utils/getFiletypeFromFileName",
  "@pierre/diffs/utils/parsePatchFiles",
]);

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const isMobileSourceFile = (filename: string): boolean =>
  normalizePath(filename).includes(MOBILE_SOURCE_MARKER);

const isRanged = (node: unknown): node is Ranged =>
  typeof node === "object" &&
  node !== null &&
  "range" in node &&
  Array.isArray(node.range) &&
  node.range.length === 2;

const getImportSource = (node: unknown): string | null => {
  if (typeof node !== "object" || node === null || !("source" in node)) {
    return null;
  }

  const source = node.source;
  if (typeof source !== "object" || source === null || !("value" in source)) {
    return null;
  }

  return typeof source.value === "string" ? source.value : null;
};

const isForbiddenPierreDiffsImport = (source: string): boolean =>
  source === PIERRE_DIFFS_PACKAGE ||
  (source.startsWith(`${PIERRE_DIFFS_PACKAGE}/`) && !ALLOWED_MOBILE_IMPORTS.has(source));

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow @pierre/diffs package-root imports in mobile code because they register DOM web components at module load.",
    },
  },
  createOnce(context) {
    const checkImport = (node: unknown) => {
      if (!isMobileSourceFile(context.filename)) return;
      if (!isRanged(node)) return;

      const source = getImportSource(node);
      if (!source || !isForbiddenPierreDiffsImport(source)) return;

      context.report({
        node,
        message:
          "Use the mobile-safe @pierre/diffs subpath exports instead. The package root imports DOM web-component code and crashes React Native/Hermes when customElements is unavailable.",
      });
    };

    return {
      ImportDeclaration: checkImport,
      ExportAllDeclaration: checkImport,
      ExportNamedDeclaration: checkImport,
    };
  },
});
