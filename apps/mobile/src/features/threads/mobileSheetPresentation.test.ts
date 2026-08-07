import { describe, expect, it } from "vite-plus/test";

import { resolveMobileSheetPresentation } from "./mobileSheetPresentation";

describe("resolveMobileSheetPresentation", () => {
  it("uses the native draggable page sheet on iOS", () => {
    expect(resolveMobileSheetPresentation("ios")).toEqual({
      allowSwipeDismissal: true,
      presentationStyle: "pageSheet",
      statusBarTranslucent: false,
      transparent: false,
    });
  });

  it("retains the transparent popup presentation on Android", () => {
    expect(resolveMobileSheetPresentation("android")).toEqual({
      allowSwipeDismissal: false,
      presentationStyle: "overFullScreen",
      statusBarTranslucent: true,
      transparent: true,
    });
  });
});
