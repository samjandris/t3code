import { SymbolView } from "expo-symbols";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
  useColorScheme,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import type { MobileMenuAction } from "../../lib/modelTraits";
import { useThemeColor } from "../../lib/useThemeColor";

export function MobileComposerOptionsSheet(props: {
  readonly visible: boolean;
  readonly actions: ReadonlyArray<MobileMenuAction>;
  readonly onClose: () => void;
  readonly onSelectAction: (event: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const isDarkMode = useColorScheme() === "dark";
  const backdropColor = isDarkMode ? "rgba(0,0,0,0.62)" : "rgba(10,10,10,0.28)";
  const panelColor = useThemeColor("--color-sheet");
  const borderColor = useThemeColor("--color-border");
  const iconColor = useThemeColor("--color-icon");
  const primaryColor = useThemeColor("--color-primary");

  const selectAction = (event: string) => {
    props.onSelectAction(event);
    props.onClose();
  };

  return (
    <Modal
      animationType="slide"
      transparent
      visible={props.visible}
      onRequestClose={props.onClose}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        className="flex-1 justify-end"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <Pressable
          style={{
            position: "absolute",
            top: 0,
            right: 0,
            bottom: 0,
            left: 0,
            // Keep the full-screen dismiss target behind the sheet. On native modal
            // surfaces this backdrop can otherwise win the responder and make rows
            // inside Properties look tappable while their actions never fire.
            zIndex: 0,
            backgroundColor: backdropColor,
          }}
          onPress={props.onClose}
        />
        <View
          style={{
            maxHeight: "84%",
            paddingTop: 14,
            paddingBottom: Math.max(insets.bottom, 14),
            paddingHorizontal: 16,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            borderWidth: 1,
            borderColor: String(borderColor),
            backgroundColor: String(panelColor),
            zIndex: 1,
          }}
        >
          <View className="flex-row items-center justify-between pb-3">
            <Text className="text-foreground text-[22px] font-t3-bold">Properties</Text>
            <Pressable
              className="h-10 w-10 items-center justify-center rounded-full bg-subtle"
              onPress={props.onClose}
            >
              <SymbolView name="xmark" size={14} tintColor={String(iconColor)} type="monochrome" />
            </Pressable>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {props.actions.map((action) => (
              <View key={action.id} className="pb-5">
                <View className="flex-row items-baseline justify-between gap-3 px-1 pb-2">
                  <Text className="text-[13px] font-t3-bold uppercase text-foreground-muted">
                    {action.title}
                  </Text>
                  {action.subtitle ? (
                    <Text className="text-[13px] font-t3-medium text-foreground-muted">
                      {action.subtitle}
                    </Text>
                  ) : null}
                </View>
                <View
                  className="overflow-hidden rounded-[20px] border border-border bg-subtle"
                  style={{ borderCurve: "continuous" }}
                >
                  {(action.subactions ?? [action]).map((subaction) => {
                    const disabled = subaction.attributes?.disabled === true;
                    return (
                      <Pressable
                        key={subaction.id}
                        className="min-h-12 flex-row items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
                        disabled={disabled}
                        style={{ opacity: disabled ? 0.45 : 1 }}
                        onPress={() => selectAction(subaction.id)}
                      >
                        <Text className="min-w-0 flex-1 text-[15px] font-t3-medium text-foreground">
                          {subaction.title}
                        </Text>
                        {subaction.state === "on" ? (
                          <SymbolView
                            name="checkmark"
                            size={15}
                            tintColor={String(primaryColor)}
                            type="monochrome"
                          />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
