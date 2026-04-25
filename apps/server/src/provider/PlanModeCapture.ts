export const T3_MANAGED_PLAN_MODE_PROMPT = `You are in T3 Code Plan Mode.

Rules:
- Do not mutate files.
- Gather context with read-only commands only.
- Ask concise clarifying questions only when required.
- When the plan is decision-complete, output exactly one <proposed_plan> block.
- Put Markdown inside the block.
- After the block, stop and wait for the user's feedback or implementation request.`;

const OPEN_TAG = "<proposed_plan>";
const CLOSE_TAG = "</proposed_plan>";

export interface PlanModeCaptureState {
  readonly capturedKeys: Set<string>;
  text: string;
}

export interface PlanModeCaptureResult {
  readonly visibleText: string;
  readonly planMarkdown?: string;
  readonly complete: boolean;
}

export function createPlanModeCaptureState(): PlanModeCaptureState {
  return {
    capturedKeys: new Set(),
    text: "",
  };
}

export function wrapPiPlanModePrompt(input: string): string {
  const trimmed = input.trim();
  return `${T3_MANAGED_PLAN_MODE_PROMPT}\n\nUser request:\n${trimmed}`;
}

export function captureProposedPlanFromText(text: string): PlanModeCaptureResult {
  const openIndex = text.indexOf(OPEN_TAG);
  if (openIndex < 0) {
    return {
      visibleText: text,
      complete: false,
    };
  }

  const contentStart = openIndex + OPEN_TAG.length;
  const closeIndex = text.indexOf(CLOSE_TAG, contentStart);
  if (closeIndex < 0) {
    return {
      visibleText: text.slice(0, openIndex),
      complete: false,
    };
  }

  const before = text.slice(0, openIndex);
  const after = text.slice(closeIndex + CLOSE_TAG.length);
  const planMarkdown = text.slice(contentStart, closeIndex).trim();
  return {
    visibleText: `${before}${after}`.trim(),
    ...(planMarkdown ? { planMarkdown } : {}),
    complete: true,
  };
}

export function appendAndCaptureProposedPlan(
  state: PlanModeCaptureState,
  delta: string,
): PlanModeCaptureResult {
  state.text += delta;
  const captured = captureProposedPlanFromText(state.text);
  if (!captured.planMarkdown) {
    return captured;
  }
  const key = captured.planMarkdown;
  if (state.capturedKeys.has(key)) {
    return {
      visibleText: captured.visibleText,
      complete: captured.complete,
    };
  }
  state.capturedKeys.add(key);
  return captured;
}
