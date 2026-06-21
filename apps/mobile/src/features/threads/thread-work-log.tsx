import * as Haptics from "expo-haptics";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useEffect, useRef } from "react";
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  useColorScheme,
  useWindowDimensions,
  View,
  type ColorValue,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";

const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;
const TOOL_SUMMARY_SHIMMER_WIDTH = 52;
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

function workRowSymbolName(icon: ThreadFeedActivity["icon"]): SFSymbol {
  switch (icon) {
    case "agent":
      return "sparkles";
    case "alert":
      return "exclamationmark.triangle";
    case "check":
      return "checkmark";
    case "command":
      return "terminal";
    case "edit":
      return "square.and.pencil";
    case "eye":
      return "eye";
    case "globe":
      return "globe";
    case "hammer":
      return "hammer";
    case "message":
      return "bubble.left";
    case "warning":
      return "xmark";
    case "wrench":
      return "wrench";
    case "zap":
      return "bolt";
  }
}

type ThreadWorkLogRowActivity = ThreadFeedActivity & {
  readonly detail: string | null;
};

function ThreadWorkLogRow(props: {
  readonly row: ThreadWorkLogRowActivity;
  readonly expanded: boolean;
  readonly copied: boolean;
  readonly iconSubtleColor: ColorValue;
  readonly pressedBackground: string;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleRow: (rowId: string) => void;
}) {
  const isToolSummaryPending = props.row.toolSummaryStatus === "pending";
  const previousToolSummaryStatusRef = useRef(props.row.toolSummaryStatus);
  const { width: windowWidth } = useWindowDimensions();
  const shimmerProgress = useSharedValue(0);
  const revealProgress = useSharedValue(0);
  const canExpand = props.row.fullDetail !== null;
  const displayText = props.row.detail
    ? `${props.row.summary} ${props.row.detail}`
    : props.row.summary;
  const iconIsDestructive = props.row.icon === "alert" || props.row.icon === "warning";

  useEffect(() => {
    if (!isToolSummaryPending) {
      shimmerProgress.value = 0;
      return;
    }
    shimmerProgress.value = 0;
    shimmerProgress.value = withRepeat(
      withTiming(1, { duration: 1650, easing: Easing.linear }),
      -1,
      false,
    );
  }, [isToolSummaryPending, shimmerProgress]);

  useEffect(() => {
    const previousStatus = previousToolSummaryStatusRef.current;
    const currentStatus = props.row.toolSummaryStatus;
    previousToolSummaryStatusRef.current = currentStatus;

    if (previousStatus === "pending" && currentStatus === "complete") {
      revealProgress.value = 0.65;
      revealProgress.value = withTiming(0, {
        duration: 640,
        easing: Easing.out(Easing.cubic),
      });
      return;
    }

    if (currentStatus !== "complete") {
      revealProgress.value = 0;
    }
  }, [props.row.toolSummaryStatus, revealProgress]);

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: isToolSummaryPending ? 0.44 : 0,
    transform: [
      {
        translateX:
          shimmerProgress.value * (Math.min(windowWidth, 320) + TOOL_SUMMARY_SHIMMER_WIDTH * 2) -
          TOOL_SUMMARY_SHIMMER_WIDTH,
      },
      { rotate: "16deg" },
    ],
  }));
  const revealStyle = useAnimatedStyle(() => ({
    opacity: revealProgress.value,
  }));

  return (
    <View>
      <Pressable
        accessibilityRole={canExpand ? "button" : undefined}
        accessibilityLabel={displayText}
        accessibilityHint={
          canExpand ? "Double tap to show full details. Long press to copy." : "Long press to copy."
        }
        accessibilityState={canExpand ? { expanded: props.expanded } : undefined}
        hitSlop={4}
        onPress={() => {
          if (canExpand) {
            triggerDisclosureFeedback();
            props.onToggleRow(props.row.id);
          }
        }}
        onLongPress={() => props.onCopyRow(props.row.id, props.row.copyText)}
        style={({ pressed }) => ({
          backgroundColor: pressed ? props.pressedBackground : "transparent",
          overflow: "hidden",
        })}
        className="rounded-md px-0.5 py-0.5"
      >
        <Animated.View
          pointerEvents="none"
          style={[
            revealStyle,
            {
              position: "absolute",
              inset: 0,
              backgroundColor: "rgba(59,130,246,0.12)",
            },
          ]}
        />
        <Animated.View
          pointerEvents="none"
          style={[
            shimmerStyle,
            {
              position: "absolute",
              top: -12,
              bottom: -12,
              width: TOOL_SUMMARY_SHIMMER_WIDTH,
              backgroundColor: "rgba(255,255,255,0.42)",
            },
          ]}
        />
        <View className="min-h-9 flex-row items-center gap-1.5">
          <View className="h-5 w-5 shrink-0 items-center justify-center">
            <SymbolView
              name={workRowSymbolName(props.row.icon)}
              size={14}
              weight="medium"
              tintColor={iconIsDestructive ? "#e11d48" : props.iconSubtleColor}
              type="monochrome"
            />
          </View>

          <Text className="min-w-0 flex-1 text-xs leading-5 text-foreground" numberOfLines={1}>
            <Text
              className={cn(
                "font-t3-medium text-foreground",
                iconIsDestructive && "text-rose-600 dark:text-rose-400",
              )}
            >
              {props.row.summary}
            </Text>
            {props.row.detail ? (
              <Text className="text-foreground-muted opacity-60"> {props.row.detail}</Text>
            ) : null}
          </Text>

          <View className="shrink-0 flex-row items-center gap-px">
            {props.copied ? (
              <Text className="pr-1 font-t3-medium text-3xs text-emerald-600 dark:text-emerald-400">
                Copied
              </Text>
            ) : null}
            <View className="h-4 w-4 items-center justify-center">
              {canExpand ? (
                <SymbolView
                  name={props.expanded ? "chevron.up" : "chevron.down"}
                  size={11}
                  tintColor={props.iconSubtleColor}
                  type="monochrome"
                />
              ) : null}
            </View>
            <View className="h-4 w-4 items-center justify-center">
              {props.row.status ? (
                <SymbolView
                  name={
                    props.row.status === "failure"
                      ? "xmark"
                      : props.row.status === "success"
                        ? "checkmark"
                        : "minus"
                  }
                  size={11}
                  tintColor={props.row.status === "failure" ? "#e11d48" : props.iconSubtleColor}
                  type="monochrome"
                />
              ) : null}
            </View>
          </View>
        </View>
      </Pressable>

      {props.expanded && props.row.fullDetail ? (
        <View className="ml-7 border-l border-neutral-300/60 pb-1.5 pl-3 pt-0.5 dark:border-white/[0.12]">
          <ScrollView
            nestedScrollEnabled
            directionalLockEnabled
            showsVerticalScrollIndicator
            style={{ maxHeight: 240 }}
            contentContainerStyle={{ paddingRight: 8 }}
          >
            <Text
              selectable
              className="text-2xs leading-[17px] text-foreground-muted"
              style={{ fontFamily: "ui-monospace" }}
            >
              {props.row.fullDetail}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

export function ThreadWorkLog(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly copiedRowId: string | null;
  readonly expanded: boolean;
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
  readonly onToggleGroup: () => void;
  readonly onToggleRow: (rowId: string) => void;
}) {
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
  const rows = props.activities
    .filter((activity) => !(activity.toolLike && activity.status === "neutral"))
    .map((activity) => ({ ...activity, detail: compactActivityDetail(activity.detail) }));

  if (rows.length === 0) {
    return null;
  }

  const hasOverflow = rows.length > MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleRows =
    hasOverflow && !props.expanded ? rows.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES) : rows;
  const hiddenCount = rows.length - visibleRows.length;
  const onlyToolRows = rows.every((row) => row.toolLike);

  return (
    <View className="-mx-1 mb-3 px-1 py-0.5">
      {!onlyToolRows ? (
        <Text className="px-0.5 pb-0.5 font-t3-medium text-2xs text-foreground-muted opacity-60">
          work log
        </Text>
      ) : null}

      <View className="gap-px">
        {visibleRows.map((row) => {
          const expanded = props.expandedRows[row.id] ?? false;

          return (
            <ThreadWorkLogRow
              key={row.id}
              row={row}
              expanded={expanded}
              copied={props.copiedRowId === row.id}
              iconSubtleColor={props.iconSubtleColor}
              pressedBackground={pressedBackground}
              onCopyRow={props.onCopyRow}
              onToggleRow={props.onToggleRow}
            />
          );
        })}
      </View>

      {hasOverflow ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: props.expanded }}
          accessibilityLabel={
            props.expanded
              ? "Show fewer tool calls"
              : `Show ${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}`
          }
          hitSlop={4}
          onPress={() => {
            triggerDisclosureFeedback();
            props.onToggleGroup();
          }}
          style={({ pressed }) => ({
            backgroundColor: pressed ? pressedBackground : "transparent",
          })}
          className="min-h-9 flex-row items-center gap-1.5 rounded-md px-0.5 py-0.5"
        >
          <View className="h-5 w-5 items-center justify-center">
            <SymbolView
              name={props.expanded ? "chevron.up" : "chevron.down"}
              size={13}
              tintColor={props.iconSubtleColor}
              type="monochrome"
            />
          </View>
          <Text className="font-t3-medium text-xs text-foreground opacity-80">
            {props.expanded
              ? "Show fewer tool calls"
              : `+${hiddenCount} previous tool ${hiddenCount === 1 ? "call" : "calls"}`}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
