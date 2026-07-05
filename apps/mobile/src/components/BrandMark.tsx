import { Image, View } from "react-native";

import { AppText as Text } from "./AppText";

const BRAND_MARK_SOURCE = require("../../../../assets/dev/blueprint-ios-1024.png");

export function BrandMark(props: { readonly compact?: boolean }) {
  const compact = props.compact ?? false;
  const iconSize = compact ? 32 : 44;

  return (
    <View className="flex-row items-center gap-3">
      <Image
        source={BRAND_MARK_SOURCE}
        accessibilityIgnoresInvertColors
        style={{
          width: iconSize,
          height: iconSize,
          borderRadius: compact ? 10 : 14,
        }}
      />
      <View className="gap-1">
        <Text className="text-lg font-t3-bold text-foreground" style={{ letterSpacing: -0.4 }}>
          T3 Code
        </Text>
        {!compact ? (
          <Text className="text-xs font-medium text-foreground-muted">
            Mobile control surface for your live coding environments
          </Text>
        ) : null}
      </View>
    </View>
  );
}
