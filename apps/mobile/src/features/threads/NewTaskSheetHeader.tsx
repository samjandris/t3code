import { SymbolView } from "expo-symbols";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

export function NewTaskSheetHeader(props: {
  readonly title: string;
  readonly control?: {
    readonly icon: ComponentProps<typeof SymbolView>["name"];
    readonly onPress: () => void;
  };
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const borderColor = useThemeColor("--color-border");

  return (
    <View
      className="flex-row items-center justify-center px-4"
      style={{
        paddingTop: insets.top + 8,
        paddingBottom: 12,
        borderBottomWidth: 1,
        borderBottomColor: borderColor,
      }}
    >
      <View className="absolute left-4" style={{ top: insets.top + 4 }}>
        {props.control ? (
          <Pressable
            accessibilityRole="button"
            onPress={props.control.onPress}
            className="h-11 w-11 items-center justify-center rounded-full bg-subtle"
          >
            <SymbolView
              name={props.control.icon}
              size={17}
              tintColor={String(iconColor)}
              type="monochrome"
            />
          </Pressable>
        ) : null}
      </View>
      <Text
        numberOfLines={1}
        className="max-w-[72%] text-center text-[17px] font-t3-bold text-foreground"
      >
        {props.title}
      </Text>
    </View>
  );
}
