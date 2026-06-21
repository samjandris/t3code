import * as Haptics from "expo-haptics";
import { SymbolView, type SFSymbol } from "expo-symbols";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  LayoutAnimation,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as NativeText,
  useColorScheme,
  useWindowDimensions,
  View,
  type ColorValue,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Mask, Rect, Stop, Text as SvgText } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { ThreadFeedActivity } from "../../lib/threadActivity";

const AnimatedNativeText = Animated.createAnimatedComponent(NativeText);
const AnimatedRect = Animated.createAnimatedComponent(Rect);
const TOOL_SUMMARY_SHIMMER_WIDTH = 52;
const WORK_LOG_FONT_SIZE = 12;
const WORK_LOG_LINE_HEIGHT = 20;
const TOOL_SUMMARY_SHIMMER_BASELINE = 14.5;
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
  const colorScheme = useColorScheme();
  const isToolSummaryPending = props.row.toolSummaryStatus === "pending";
  const previousToolSummaryStatusRef = useRef(props.row.toolSummaryStatus);
  const { width: windowWidth } = useWindowDimensions();
  const [textWidth, setTextWidth] = useState(0);
  const shimmerProgress = useSharedValue(0);
  const revealProgress = useSharedValue(0);
  const canExpand = props.row.fullDetail !== null;
  const displayText = props.row.detail
    ? `${props.row.summary} ${props.row.detail}`
    : props.row.summary;
  const iconIsDestructive = props.row.icon === "alert" || props.row.icon === "warning";
  const glintColor = colorScheme === "dark" ? "rgba(255,255,255,0.72)" : "rgba(23,23,23,0.46)";
  const shimmerTravelDistance =
    Math.max(textWidth, Math.min(windowWidth, 320)) + TOOL_SUMMARY_SHIMMER_WIDTH * 2;
  const overlayTextWidth = Math.max(textWidth, windowWidth);
  const svgId = useMemo(() => props.row.id.replace(/[^a-zA-Z0-9_-]/g, "-"), [props.row.id]);
  const shimmerGradientId = `tool-summary-shimmer-gradient-${svgId}`;
  const shimmerMaskId = `tool-summary-shimmer-mask-${svgId}`;

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

  const shimmerProps = useAnimatedProps(() => ({
    x: shimmerProgress.value * shimmerTravelDistance - TOOL_SUMMARY_SHIMMER_WIDTH,
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

          <View className="min-w-0 flex-1 overflow-hidden">
            <Text
              className="text-xs leading-5 text-foreground"
              numberOfLines={1}
              onLayout={(event) => {
                const nextTextWidth = Math.ceil(event.nativeEvent.layout.width);
                setTextWidth((currentTextWidth) =>
                  currentTextWidth === nextTextWidth ? currentTextWidth : nextTextWidth,
                );
              }}
            >
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
            {isToolSummaryPending && textWidth > 0 ? (
              <Svg
                pointerEvents="none"
                style={StyleSheet.absoluteFill}
                width={overlayTextWidth}
                height={WORK_LOG_LINE_HEIGHT}
              >
                <Defs>
                  <LinearGradient id={shimmerGradientId} x1="0" x2="1" y1="0" y2="0">
                    <Stop offset="0" stopColor={glintColor} stopOpacity="0" />
                    <Stop offset="0.48" stopColor={glintColor} stopOpacity="0.72" />
                    <Stop offset="1" stopColor={glintColor} stopOpacity="0" />
                  </LinearGradient>
                  <Mask
                    id={shimmerMaskId}
                    x="0"
                    y="0"
                    width={overlayTextWidth}
                    height={WORK_LOG_LINE_HEIGHT}
                    maskUnits="userSpaceOnUse"
                  >
                    <SvgText
                      fill="#fff"
                      fontFamily="DMSans_500Medium"
                      fontSize={WORK_LOG_FONT_SIZE}
                      x="0"
                      y={TOOL_SUMMARY_SHIMMER_BASELINE}
                    >
                      {displayText}
                    </SvgText>
                  </Mask>
                </Defs>
                <AnimatedRect
                  animatedProps={shimmerProps}
                  y="0"
                  width={TOOL_SUMMARY_SHIMMER_WIDTH}
                  height={WORK_LOG_LINE_HEIGHT}
                  fill={`url(#${shimmerGradientId})`}
                  mask={`url(#${shimmerMaskId})`}
                />
              </Svg>
            ) : null}
            <AnimatedNativeText
              pointerEvents="none"
              numberOfLines={1}
              style={[
                {
                  ...StyleSheet.absoluteFill,
                  color: glintColor,
                  fontFamily: "DMSans_500Medium",
                  fontSize: WORK_LOG_FONT_SIZE,
                  lineHeight: WORK_LOG_LINE_HEIGHT,
                },
                revealStyle,
              ]}
            >
              {displayText}
            </AnimatedNativeText>
          </View>

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
  readonly expandedRows: Readonly<Record<string, boolean>>;
  readonly iconSubtleColor: ColorValue;
  readonly onCopyRow: (rowId: string, value: string) => void;
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
  const colorScheme = useColorScheme();
  const pressedBackground = colorScheme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.035)";
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
            name={props.expanded ? "chevron.up" : "chevron.down"}
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
