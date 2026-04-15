export type ReviewHighlighterEnginePreference = "javascript" | "native";
export type ReviewHighlighterEngine = "javascript" | "native";

export function resolveReviewHighlighterEnginePreference(
  value: string | undefined,
): ReviewHighlighterEnginePreference {
  switch (value) {
    case "javascript":
    case "native":
      return value;
    default:
      return "javascript";
  }
}

export function resolveReviewHighlighterEngine(
  preference: ReviewHighlighterEnginePreference,
  nativeAvailable: boolean,
): ReviewHighlighterEngine {
  if (preference === "javascript") {
    return "javascript";
  }

  if (nativeAvailable) {
    return "native";
  }

  return "javascript";
}
