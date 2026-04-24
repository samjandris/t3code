export type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";
export type ClaudeAgentEffort = CodexReasoningEffort | "max" | "ultrathink";

export const CODEX_REASONING_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly CodexReasoningEffort[];

export const CLAUDE_AGENT_EFFORT_OPTIONS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
] as const satisfies readonly ClaudeAgentEffort[];

export function isCodexReasoningEffort(value: string): value is CodexReasoningEffort {
  return CODEX_REASONING_EFFORT_OPTIONS.some((option) => option === value);
}
