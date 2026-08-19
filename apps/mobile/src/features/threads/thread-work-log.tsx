import * as Haptics from "expo-haptics";
import { type AppSymbolName, SymbolView } from "../../components/AppSymbol";
import { useEffect, useState } from "react";
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  Text as NativeText,
  useColorScheme,
  View,
} from "react-native";

import { AppText as Text } from "../../components/AppText";
import { scaledTypographyLineHeight } from "../../lib/appearancePreferences";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";
import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import { useThemeColor } from "../../lib/useThemeColor";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

const AnimatedNativeText = Animated.createAnimatedComponent(NativeText);
const AnimatedView = Animated.createAnimatedComponent(View);
const TOOL_SUMMARY_SHIMMER_WIDTH = 52;
const WORK_LOG_LINE_HEIGHT = 20;
const WORK_LOG_LAYOUT_ANIMATION = {
  duration: 180,
  create: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
  update: { type: LayoutAnimation.Types.easeInEaseOut },
  delete: {
    type: LayoutAnimation.Types.easeInEaseOut,
    property: LayoutAnimation.Properties.opacity,
  },
} as const;

function triggerDisclosureFeedback() {
  LayoutAnimation.configureNext(WORK_LOG_LAYOUT_ANIMATION);
  void Haptics.selectionAsync();
}

function stripShellWrapper(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^\/bin\/zsh -lc ['"]?([\s\S]*?)['"]?$/);
  return (match?.[1] ?? trimmed).trim();
}

function compactActivityDetail(detail: string | null): string | null {
  if (!detail) {
    return null;
  }

  const cleaned = stripShellWrapper(detail).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): AppSymbolName {
  switch (icon) {
    case "agent":
      return { ios: "sparkles", android: "auto_awesome" };
    case "alert":
      return { ios: "exclamationmark.triangle", android: "error" };
    case "check":
      return { ios: "checkmark", android: "check" };
    case "command":
      return { ios: "terminal", android: "terminal" };
    case "edit":
      return { ios: "square.and.pencil", android: "edit" };
    case "eye":
      return { ios: "eye", android: "visibility" };
    case "globe":
      return { ios: "globe", android: "public" };
    case "hammer":
      return { ios: "hammer", android: "construction" };
    case "message":
      return { ios: "bubble.left", android: "chat_bubble" };
    case "warning":
      return { ios: "xmark", android: "close" };
    case "wrench":
      return { ios: "wrench", android: "build" };
    case "zap":
      return { ios: "bolt", android: "bolt" };
  }
}

// Entering fades only for rows created moments ago: rows remount whenever the
// list scrolls them back into view, and old rows must not replay an entrance.
const FRESH_ROW_WINDOW_MS = 3_000;
function isFreshRow(createdAt: string): boolean {
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && Date.now() - timestamp < FRESH_ROW_WINDOW_MS;
}

// Tool-like activities with a neutral status carry no signal worth a row.
export function visibleWorkLogActivities(
  activities: ReadonlyArray<ThreadFeedActivity>,
): ReadonlyArray<ThreadFeedActivity> {
  return activities.filter((activity) => !(activity.toolLike && activity.status === "neutral"));
}

// Pre-measurement heights for the feed's getFixedItemSize. Collapsed work-log
// rows are single-line (numberOfLines={1}) inside a min-height that stays
// taller than the text at every supported base font size (text-xs reaches
// 23px at the 22pt maximum, under the 32px min-h-8), so row height is
// deterministic. The "work log" label has no such clamp — its height follows
// the scaled text-2xs line height. Values mirror the classNames below — keep
// them in sync; a mismatch only costs a one-time correction on measure.
const WORK_ROW_HEIGHT = 32; // min-h-8
const WORK_ROW_GAP = 1; // gap-px
const WORK_LOG_HEADER_PADDING = 2; // pb-0.5 under the "work log" label
const WORK_LOG_BOTTOM_MARGIN = 4; // mb-1

export const WORK_GROUP_TOGGLE_HEIGHT = 36; // min-h-8 (32) + mb-1 (4)

export function collapsedWorkLogHeight(
  activities: ReadonlyArray<ThreadFeedActivity>,
  baseFontSize: number,
): number {
  const rows = visibleWorkLogActivities(activities);
  if (rows.length === 0) {
    return 0;
  }
  const onlyToolRows = rows.every((row) => row.toolLike);
  const headerHeight =
    scaledTypographyLineHeight(MOBILE_TYPOGRAPHY.caption, baseFontSize) + WORK_LOG_HEADER_PADDING;
  return (
    WORK_LOG_BOTTOM_MARGIN +
    (onlyToolRows ? 0 : headerHeight) +
    rows.length * WORK_ROW_HEIGHT +
    (rows.length - 1) * WORK_ROW_GAP
  );
}

function ToolSummaryPreview(props: { readonly text: string; readonly pending: boolean }) {
  const colorScheme = useColorScheme();
  const [width, setWidth] = useState(0);
  const shimmerProgress = useSharedValue(0);
  const shimmerTravelDistance = width + TOOL_SUMMARY_SHIMMER_WIDTH * 2;
  const glintColor = colorScheme === "dark" ? "rgba(255,255,255,0.72)" : "rgba(23,23,23,0.46)";

  useEffect(() => {
    if (!props.pending) {
      shimmerProgress.value = 0;
      return;
    }
    shimmerProgress.value = withRepeat(
      withTiming(1, { duration: 1650, easing: Easing.linear }),
      -1,
      false,
    );
  }, [props.pending, shimmerProgress]);

  const shimmerWindowStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: shimmerProgress.value * shimmerTravelDistance - TOOL_SUMMARY_SHIMMER_WIDTH,
      },
    ],
  }));
  const shimmerTextStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: TOOL_SUMMARY_SHIMMER_WIDTH - shimmerProgress.value * shimmerTravelDistance,
      },
    ],
  }));

  return (
    <View
      className="min-w-0 flex-1 overflow-hidden"
      style={{ height: WORK_LOG_LINE_HEIGHT }}
      onLayout={(event) => {
        const nextWidth = Math.ceil(event.nativeEvent.layout.width);
        setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
      }}
    >
      <Text className="text-xs leading-5 text-foreground-muted opacity-60" numberOfLines={1}>
        {props.text}
      </Text>
      {props.pending && width > 0 ? (
        <AnimatedView
          pointerEvents="none"
          style={[
            {
              position: "absolute",
              bottom: 0,
              left: 0,
              top: 0,
              width: TOOL_SUMMARY_SHIMMER_WIDTH,
              overflow: "hidden",
            },
            shimmerWindowStyle,
          ]}
        >
          <AnimatedNativeText
            className="font-sans text-xs leading-5"
            numberOfLines={1}
            style={[
              {
                position: "absolute",
                left: 0,
                top: 0,
                width,
                color: glintColor,
              },
              shimmerTextStyle,
            ]}
          >
            {props.text}
          </AnimatedNativeText>
        </AnimatedView>
      ) : null}
    </View>
  );
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
}) {
  const pressedBackground = useThemeColor("--color-subtle");
  const rows = visibleWorkLogActivities(props.activities).map((activity) => ({
    ...activity,
    detail: compactActivityDetail(activity.detail),
  }));

  if (rows.length === 0) {
    return null;
  }

  const onlyToolRows = rows.every((row) => row.toolLike);

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      {!onlyToolRows ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {rows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;
          const canExpand = row.canExpand;
          const fullDetail = expanded ? row.getFullDetail() : null;
          const displayText = row.detail ? `${row.summary} ${row.detail}` : row.summary;
          const iconIsDestructive = row.icon === "alert" || row.icon === "warning";

          return (
            <Animated.View
              key={row.id}
              {...(isFreshRow(row.createdAt) ? { entering: FadeIn.duration(200) } : {})}
            >
              <Pressable
                accessibilityRole={canExpand ? "button" : undefined}
                accessibilityLabel={displayText}
                accessibilityHint={
                  canExpand
                    ? "Double tap to show full details. Long press to copy."
                    : "Long press to copy."
                }
                accessibilityState={canExpand ? { expanded } : undefined}
                hitSlop={4}
                onPress={() => {
                  if (canExpand) {
                    triggerDisclosureFeedback();
                    props.onToggleRow(row.id);
                  }
                }}
                onLongPress={() => props.onCopyRow(row.id, row.getCopyText())}
                style={({ pressed }) => ({
                  backgroundColor: pressed ? pressedBackground : "transparent",
                })}
                className="rounded-md px-0.5 py-0"
              >
                <View className="min-h-8 flex-row items-center gap-1.5">
                  <View className="h-[18px] w-5 shrink-0 items-center justify-center">
                    <SymbolView
                      name={workRowSymbolName(row.icon)}
                      size={13}
                      weight="medium"
                      tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
                      type="monochrome"
                    />
                  </View>

                  <View className="min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden">
                    <Text
                      className={cn(
                        "shrink-0 font-t3-medium text-xs leading-5 text-foreground",
                        iconIsDestructive && "text-rose-600 dark:text-rose-400",
                      )}
                      numberOfLines={1}
                    >
                      {row.summary}
                    </Text>
                    {row.detail ? (
                      <ToolSummaryPreview
                        text={row.detail}
                        pending={row.toolSummaryStatus === "pending"}
                      />
                    ) : null}
                  </View>

                  <View className="shrink-0 flex-row items-center gap-px">
                    {props.copiedRowId === row.id ? (
                      <Text className="pr-1 font-t3-medium text-3xs text-emerald-600 dark:text-emerald-400">
                        Copied
                      </Text>
                    ) : null}
                    <View className="h-4 w-4 items-center justify-center">
                      {canExpand ? (
                        <SymbolView
                          name={
                            expanded
                              ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                              : { ios: "chevron.down", android: "keyboard_arrow_down" }
                          }
                          size={11}
                          tintColor={props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                    <View className="h-4 w-4 items-center justify-center">
                      {row.status ? (
                        <SymbolView
                          name={
                            row.status === "failure"
                              ? { ios: "xmark", android: "close" }
                              : row.status === "success"
                                ? { ios: "checkmark", android: "check" }
                                : { ios: "minus", android: "remove" }
                          }
                          size={11}
                          tintColor={row.status === "failure" ? "#e11d48" : props.iconSubtleColor}
                          type="monochrome"
                        />
                      ) : null}
                    </View>
                  </View>
                </View>
              </Pressable>

              {fullDetail ? (
                <View className="ml-7 border-l border-neutral-300/60 pb-1 pl-3 pt-0.5 dark:border-white/[0.12]">
                  <ScrollView
                    nestedScrollEnabled
                    directionalLockEnabled
                    showsVerticalScrollIndicator
                    className="max-h-60"
                    contentContainerStyle={{ paddingRight: 8 }}
                  >
                    <Text
                      selectable
                      className="font-mono text-2xs leading-normal text-foreground-muted"
                    >
                      {fullDetail}
                    </Text>
                  </ScrollView>
                </View>
              ) : null}
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

export function ThreadWorkGroupToggle(props: {
  readonly expanded: boolean;
  readonly hiddenCount: number;
  readonly iconSubtleColor: import("react-native").ColorValue;
  readonly onlyToolActivities: boolean;
  readonly onToggle: () => void;
}) {
  const pressedBackground = useThemeColor("--color-subtle");
  const noun = props.onlyToolActivities
    ? props.hiddenCount === 1
      ? "tool call"
      : "tool calls"
    : props.hiddenCount === 1
      ? "log entry"
      : "log entries";
  const collapsedLabel = `Show ${props.hiddenCount} previous ${noun}`;
  const expandedLabel = props.onlyToolActivities
    ? "Show fewer tool calls"
    : "Show fewer log entries";

  return (
    <View className="-mx-1 mb-1 px-1 py-0">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: props.expanded }}
        accessibilityLabel={props.expanded ? expandedLabel : collapsedLabel}
        hitSlop={4}
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
        style={({ pressed }) => ({
          backgroundColor: pressed ? pressedBackground : "transparent",
        })}
        className="min-h-8 flex-row items-center gap-1.5 rounded-md px-0.5 py-0"
      >
        <View className="h-[18px] w-5 items-center justify-center">
          <SymbolView
            name={
              props.expanded
                ? { ios: "chevron.up", android: "keyboard_arrow_up" }
                : { ios: "chevron.down", android: "keyboard_arrow_down" }
            }
            size={12}
            tintColor={props.iconSubtleColor}
            type="monochrome"
          />
        </View>
        <Text className="font-t3-medium text-xs text-foreground opacity-80">
          {props.expanded ? expandedLabel : `+${props.hiddenCount} previous ${noun}`}
        </Text>
      </Pressable>
    </View>
  );
}
