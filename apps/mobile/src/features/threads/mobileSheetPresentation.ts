import type { ModalProps, PlatformOSType } from "react-native";

type MobileSheetPresentation = Pick<
  ModalProps,
  "allowSwipeDismissal" | "presentationStyle" | "statusBarTranslucent" | "transparent"
>;

export function resolveMobileSheetPresentation(platform: PlatformOSType): MobileSheetPresentation {
  if (platform === "ios") {
    return {
      allowSwipeDismissal: true,
      presentationStyle: "pageSheet",
      statusBarTranslucent: false,
      transparent: false,
    };
  }

  return {
    allowSwipeDismissal: false,
    presentationStyle: "overFullScreen",
    statusBarTranslucent: true,
    transparent: true,
  };
}
