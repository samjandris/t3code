import { describe, expect, it } from "vitest";

import {
  appendAndCaptureProposedPlan,
  captureProposedPlanFromText,
  createPlanModeCaptureState,
  wrapPiPlanModePrompt,
} from "./PlanModeCapture.ts";

describe("PlanModeCapture", () => {
  it("extracts a complete proposed plan block", () => {
    expect(captureProposedPlanFromText("intro <proposed_plan>\n# Plan\n</proposed_plan>")).toEqual({
      visibleText: "intro",
      planMarkdown: "# Plan",
      complete: true,
    });
  });

  it("captures a streamed plan only once", () => {
    const state = createPlanModeCaptureState();

    expect(appendAndCaptureProposedPlan(state, "<proposed_plan># P")).toEqual({
      visibleText: "",
      complete: false,
    });
    expect(appendAndCaptureProposedPlan(state, "lan</proposed_plan>")).toEqual({
      visibleText: "",
      planMarkdown: "# Plan",
      complete: true,
    });
    expect(appendAndCaptureProposedPlan(state, "")).toEqual({
      visibleText: "",
      complete: true,
    });
  });

  it("wraps Pi plan mode prompts with mutation guardrails", () => {
    const wrapped = wrapPiPlanModePrompt("Add Pi");

    expect(wrapped).toContain("Do not mutate files.");
    expect(wrapped).toContain("<proposed_plan>");
    expect(wrapped).toContain("Add Pi");
  });
});
