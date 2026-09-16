import { useSyncExternalStore } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { FullWindowOverlay } from "react-native-screens";
import { getVideoCompressionState, subscribeVideoCompression } from "../lib/composerVideo";
import { AppText } from "./AppText";

export function VideoCompressionDialog() {
  const state = useSyncExternalStore(subscribeVideoCompression, getVideoCompressionState);
  if (state === null) return null;
  const content = (
    <View className="flex-1 items-center justify-center bg-backdrop px-6">
      <View className="w-full max-w-sm gap-4 rounded-2xl bg-card p-6">
        <AppText className="text-lg font-t3-medium">Compressing video</AppText>
        <AppText numberOfLines={2}>{state.name}</AppText>
        <AppText accessibilityLiveRegion="polite">
          {Math.round(Math.max(0, Math.min(1, state.progress)) * 100)}%
          {state.attempt === 2 ? ", trying a smaller version" : ""}
        </AppText>
        <Pressable
          accessibilityRole="button"
          onPress={state.cancel}
          className="items-center rounded-lg border border-border p-3"
        >
          <AppText>Cancel</AppText>
        </Pressable>
      </View>
    </View>
  );
  // New tasks use native sheets. A root Modal cannot present over those on iOS.
  if (Platform.OS === "ios") {
    return (
      <FullWindowOverlay unstable_accessibilityContainerViewIsModal>{content}</FullWindowOverlay>
    );
  }
  return (
    <Modal visible transparent animationType="fade" onRequestClose={state.cancel}>
      {content}
    </Modal>
  );
}
