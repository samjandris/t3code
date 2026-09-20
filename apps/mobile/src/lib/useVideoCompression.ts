import { useSyncExternalStore } from "react";
import {
  getVideoCompressionState,
  isVideoCompressing,
  subscribeVideoCompression,
} from "./composerVideo";

export function useIsVideoCompressing() {
  return useSyncExternalStore(subscribeVideoCompression, isVideoCompressing);
}

export function useVideoCompression() {
  return useSyncExternalStore(subscribeVideoCompression, getVideoCompressionState);
}
