import * as WebBrowser from "expo-web-browser";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import {
  beginChatGptDeviceLogin,
  completeChatGptDeviceLogin,
  revokeChatGptAuthSession,
  type ChatGptAuthSession,
  type ChatGptDeviceLogin,
} from "../dictation/chatgptAuth";
import {
  clearChatGptAuthSession,
  getValidChatGptAuthSession,
  saveChatGptAuthSession,
} from "../dictation/chatgptAuthStore";
import { SettingsSection } from "./components/SettingsSection";

type LoginPhase = "idle" | "starting" | "ready" | "waiting";

export function SettingsDictationRouteScreen() {
  const insets = useSafeAreaInsets();
  const [session, setSession] = useState<ChatGptAuthSession | null>(null);
  const [login, setLogin] = useState<ChatGptDeviceLogin | null>(null);
  const [phase, setPhase] = useState<LoginPhase>("idle");
  const [codeCopied, setCodeCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loginAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void getValidChatGptAuthSession()
      .then((value) => {
        if (active) setSession(value);
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Could not read ChatGPT sign-in.");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      loginAbortRef.current?.abort();
      dismissAuthSession();
    };
  }, []);

  const openLoginPage = async (deviceLogin: ChatGptDeviceLogin) => {
    dismissAuthSession();
    try {
      await WebBrowser.openAuthSessionAsync(deviceLogin.verificationUrl, null, {
        preferEphemeralSession: false,
      });
    } catch (cause) {
      if (!isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "Could not open ChatGPT sign-in.");
      }
    }
  };

  const startLogin = async () => {
    if (phase !== "idle") return;
    const abortController = new AbortController();
    loginAbortRef.current = abortController;
    setError(null);
    setLogin(null);
    setCodeCopied(false);
    setPhase("starting");
    try {
      const deviceLogin = await beginChatGptDeviceLogin({ signal: abortController.signal });
      setLogin(deviceLogin);
      setPhase("ready");
    } catch (cause) {
      if (!isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "ChatGPT sign-in failed.");
      }
      setPhase("idle");
      loginAbortRef.current = null;
    }
  };

  const continueLogin = async () => {
    if (!login || phase !== "ready" || !codeCopied) return;
    const abortController = loginAbortRef.current;
    if (!abortController) return;
    setError(null);
    setPhase("waiting");
    void openLoginPage(login);
    try {
      const nextSession = await completeChatGptDeviceLogin(login, {
        signal: abortController.signal,
      });
      await saveChatGptAuthSession(nextSession);
      setSession(nextSession);
      setLogin(null);
      setPhase("idle");
      dismissAuthSession();
    } catch (cause) {
      if (!isAbortError(cause)) {
        setError(cause instanceof Error ? cause.message : "ChatGPT sign-in failed.");
      }
      setLogin(null);
      setCodeCopied(false);
      setPhase("idle");
    } finally {
      loginAbortRef.current = null;
    }
  };

  const cancelLogin = () => {
    loginAbortRef.current?.abort();
    loginAbortRef.current = null;
    setLogin(null);
    setCodeCopied(false);
    setPhase("idle");
    dismissAuthSession();
  };

  const signOut = () => {
    if (!session) return;
    Alert.alert(
      "Sign out of ChatGPT?",
      "ChatGPT transcription and cleanup will stop on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign Out",
          style: "destructive",
          onPress: () => {
            const current = session;
            setSession(null);
            void revokeChatGptAuthSession(current).catch(() => undefined);
            void clearChatGptAuthSession().catch(() => {
              setError("Could not remove the ChatGPT sign-in from this device.");
              setSession(current);
            });
          },
        },
      ],
    );
  };

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        showsVerticalScrollIndicator={false}
      >
        <View className="items-center gap-3 px-6 py-3">
          <View className="size-16 items-center justify-center rounded-full bg-subtle">
            <SymbolView
              name="microphone.fill"
              size={28}
              tintColorClassName="accent-icon"
              type="monochrome"
              weight="medium"
            />
          </View>
          <Text className="text-center text-xl font-t3-bold text-foreground">Voice Dictation</Text>
          <Text className="text-center text-sm leading-normal text-foreground-muted">
            Sign in to transcribe and clean up dictation with ChatGPT. Without a sign-in, supported
            iPhones use on-device transcription.
          </Text>
        </View>

        <SettingsSection title="ChatGPT account" card>
          {loading ? (
            <View className="items-center gap-3 px-6 py-8">
              <ActivityIndicator />
              <Text className="text-sm text-foreground-muted">Checking sign-in...</Text>
            </View>
          ) : session ? (
            <View className="gap-4 p-4">
              <View className="flex-row items-center gap-3">
                <SymbolView
                  name="checkmark.circle"
                  size={24}
                  tintColorClassName="accent-icon"
                  type="monochrome"
                  weight="medium"
                />
                <View className="min-w-0 flex-1">
                  <Text className="text-base font-t3-bold text-foreground">Signed in</Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {session.email ?? formatPlan(session.planType)}
                  </Text>
                </View>
              </View>
              <ActionButton destructive label="Sign out" onPress={signOut} />
            </View>
          ) : login ? (
            <View className="items-center gap-4 p-5">
              <Text className="text-center text-sm leading-normal text-foreground-muted">
                {phase === "ready"
                  ? "Step 1 of 2. Copy this one-time code."
                  : "Step 2 of 2. Paste it in ChatGPT to finish signing in."}
              </Text>
              <Pressable
                accessibilityHint="Copies the one-time ChatGPT sign-in code"
                accessibilityRole="button"
                className="rounded-2xl bg-subtle px-6 py-4 active:opacity-70"
                onPress={() => {
                  copyTextWithHaptic(login.userCode, { target: "ChatGPT login code" });
                  setCodeCopied(true);
                }}
              >
                <Text selectable className="text-2xl font-t3-bold tracking-[3px] text-foreground">
                  {login.userCode}
                </Text>
              </Pressable>
              <View className="w-full gap-2">
                {phase === "ready" ? (
                  <>
                    <ActionButton
                      label={codeCopied ? "Code copied" : "Copy code"}
                      onPress={() => {
                        copyTextWithHaptic(login.userCode, { target: "ChatGPT login code" });
                        setCodeCopied(true);
                      }}
                    />
                    <ActionButton
                      disabled={!codeCopied}
                      label="Open ChatGPT"
                      onPress={() => void continueLogin()}
                    />
                  </>
                ) : (
                  <ActionButton
                    label="Open ChatGPT again"
                    onPress={() => void openLoginPage(login)}
                  />
                )}
                <ActionButton destructive label="Cancel" onPress={cancelLogin} />
              </View>
              {phase === "waiting" ? (
                <View className="flex-row items-center gap-2">
                  <ActivityIndicator size="small" />
                  <Text className="text-sm text-foreground-muted">
                    Finish signing in with ChatGPT...
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View className="gap-4 p-4">
              <Text className="text-sm leading-normal text-foreground-muted">
                Sign in the same way as Codex. Your tokens stay encrypted on this device.
              </Text>
              <ActionButton
                busy={phase === "starting"}
                label="Sign in with ChatGPT"
                onPress={() => void startLogin()}
              />
            </View>
          )}
        </SettingsSection>

        {error ? (
          <Text selectable className="px-2 text-sm leading-normal text-danger-foreground">
            {error}
          </Text>
        ) : null}

        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Dictation uses Codex's private service, which OpenAI may change or remove.
        </Text>
      </ScrollView>
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}) {
  const disabled = props.busy || props.disabled;
  return (
    <Pressable
      accessibilityRole="button"
      className={
        props.destructive
          ? "h-12 items-center justify-center rounded-full bg-subtle active:opacity-70"
          : "h-12 items-center justify-center rounded-full bg-primary active:opacity-70"
      }
      disabled={disabled}
      onPress={props.onPress}
      style={disabled ? { opacity: 0.45 } : undefined}
    >
      {props.busy ? (
        <ActivityIndicator colorClassName="accent-primary-foreground" />
      ) : (
        <Text
          className={
            props.destructive
              ? "font-t3-bold text-danger-foreground"
              : "font-t3-bold text-primary-foreground"
          }
        >
          {props.label}
        </Text>
      )}
    </Pressable>
  );
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === "AbortError";
}

function dismissAuthSession(): void {
  try {
    WebBrowser.dismissAuthSession();
  } catch {
    // Android's browser fallback has no programmatic auth-session dismissal.
  }
}

function formatPlan(planType: string | null): string {
  if (!planType) return "ChatGPT account";
  return `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`;
}
