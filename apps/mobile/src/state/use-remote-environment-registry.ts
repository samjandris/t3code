import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo } from "react";
import { Alert, AppState, type AppStateStatus } from "react-native";

import {
  type EnvironmentRuntimeState,
  createEnvironmentConnection,
  createKnownEnvironment,
  createWsRpcClient,
  EnvironmentConnectionState,
  WsTransport,
} from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/shared/remote";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { Atom } from "effect/unstable/reactivity";
import { type SavedRemoteConnection, bootstrapRemoteConnection } from "../lib/connection";
import { terminalDebugLog } from "../features/terminal/terminalDebugLog";
import {
  clearCachedShellSnapshot,
  clearSavedConnection,
  loadCachedShellSnapshot,
  loadSavedConnections,
  saveCachedShellSnapshot,
  saveConnection,
} from "../lib/storage";
import { appAtomRegistry } from "./atom-registry";
import {
  drainEnvironmentSessions,
  listEnvironmentSessions,
  notifyEnvironmentConnectionListeners,
  removeEnvironmentSession,
  setEnvironmentSession,
} from "./environment-session-registry";
import { type ConnectedEnvironmentSummary } from "./remote-runtime-types";
import {
  invalidateSourceControlDiscoveryForEnvironment,
  resetSourceControlDiscoveryState,
} from "./use-source-control-discovery";
import { environmentRuntimeManager, useEnvironmentRuntimeStates } from "./use-environment-runtime";
import {
  clearCachedShellSnapshotMetadata,
  hydrateCachedShellSnapshot,
  markShellSnapshotLive,
  shellSnapshotManager,
} from "./use-shell-snapshot";
import { subscribeTerminalMetadata, terminalSessionManager } from "./use-terminal-session";

const terminalMetadataUnsubscribers = new Map<EnvironmentId, () => void>();
const SAVED_CONNECTION_BOOTSTRAP_TIMEOUT_MS = 8_000;
const APP_RESUME_RECONNECT_COOLDOWN_MS = 5_000;
const HEARTBEAT_TIMEOUT_RECONNECT_COOLDOWN_MS = 5_000;
const HEARTBEAT_STALE_MS = 15_000;
const SOCKET_CLOSE_RECONNECT_DELAY_MS = 750;

interface RemoteEnvironmentLocalState {
  readonly isLoadingSavedConnection: boolean;
  readonly connectionPairingUrl: string;
  readonly pendingConnectionError: string | null;
  readonly savedConnectionsById: Record<EnvironmentId, SavedRemoteConnection>;
}

const isLoadingSavedConnectionAtom = Atom.make(true).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:is-loading-saved-connection"),
);

const connectionPairingUrlAtom = Atom.make("").pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:connection-pairing-url"),
);

const pendingConnectionErrorAtom = Atom.make<string | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:pending-connection-error"),
);

const savedConnectionsByIdAtom = Atom.make<Record<EnvironmentId, SavedRemoteConnection>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:saved-connections"),
);

function getSavedConnectionsById(): Record<EnvironmentId, SavedRemoteConnection> {
  return appAtomRegistry.get(savedConnectionsByIdAtom);
}

function setIsLoadingSavedConnection(value: boolean): void {
  appAtomRegistry.set(isLoadingSavedConnectionAtom, value);
}

function setConnectionPairingUrl(pairingUrl: string): void {
  appAtomRegistry.set(connectionPairingUrlAtom, pairingUrl);
}

function clearConnectionPairingUrl(): void {
  appAtomRegistry.set(connectionPairingUrlAtom, "");
}

export function setPendingConnectionError(message: string | null): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, message);
}

function clearPendingConnectionError(): void {
  appAtomRegistry.set(pendingConnectionErrorAtom, null);
}

function replaceSavedConnections(connections: Record<EnvironmentId, SavedRemoteConnection>): void {
  appAtomRegistry.set(savedConnectionsByIdAtom, connections);
}

function upsertSavedConnection(connection: SavedRemoteConnection): void {
  const current = appAtomRegistry.get(savedConnectionsByIdAtom);
  appAtomRegistry.set(savedConnectionsByIdAtom, {
    ...current,
    [connection.environmentId]: connection,
  });
}

function removeSavedConnection(environmentId: EnvironmentId): void {
  const current = appAtomRegistry.get(savedConnectionsByIdAtom);
  const next = { ...current };
  delete next[environmentId];
  appAtomRegistry.set(savedConnectionsByIdAtom, next);
}

function useRemoteEnvironmentLocalState(): RemoteEnvironmentLocalState {
  const isLoadingSavedConnection = useAtomValue(isLoadingSavedConnectionAtom);
  const connectionPairingUrl = useAtomValue(connectionPairingUrlAtom);
  const pendingConnectionError = useAtomValue(pendingConnectionErrorAtom);
  const savedConnectionsById = useAtomValue(savedConnectionsByIdAtom);

  return useMemo(
    () => ({
      isLoadingSavedConnection,
      connectionPairingUrl,
      pendingConnectionError,
      savedConnectionsById,
    }),
    [connectionPairingUrl, isLoadingSavedConnection, pendingConnectionError, savedConnectionsById],
  );
}

function setEnvironmentConnectionStatus(
  environmentId: EnvironmentId,
  state: ConnectedEnvironmentSummary["connectionState"],
  error?: string | null,
) {
  environmentRuntimeManager.patch({ environmentId }, (current) => ({
    ...current,
    connectionState: state,
    connectionError: error === undefined ? current.connectionError : error,
  }));
}

let lastAppResumeReconnectAt = 0;

function reconnectStaleEnvironmentSessions(reason: string): void {
  const now = Date.now();
  if (now - lastAppResumeReconnectAt < APP_RESUME_RECONNECT_COOLDOWN_MS) {
    return;
  }

  let didReconnect = false;
  for (const session of listEnvironmentSessions()) {
    if (session.client.isHeartbeatFresh(HEARTBEAT_STALE_MS)) {
      continue;
    }

    didReconnect = true;
    setEnvironmentConnectionStatus(session.connection.environmentId, "reconnecting", null);
    void session.connection.reconnect().catch((error) => {
      setEnvironmentConnectionStatus(
        session.connection.environmentId,
        "disconnected",
        error instanceof Error
          ? error.message
          : `Failed to reconnect remote environment after ${reason}.`,
      );
    });
  }

  if (didReconnect) {
    lastAppResumeReconnectAt = now;
  }
}

function subscribeAppResumeReconnects(): () => void {
  let previousState: AppStateStatus = AppState.currentState;
  const subscription = AppState.addEventListener("change", (nextState) => {
    const wasBackgrounded = previousState === "background" || previousState === "inactive";
    previousState = nextState;

    if (nextState === "active" && wasBackgrounded) {
      reconnectStaleEnvironmentSessions("app resume");
    }
  });

  return () => {
    subscription.remove();
  };
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

export async function disconnectEnvironment(
  environmentId: EnvironmentId,
  options?: { readonly preserveShellSnapshot?: boolean; readonly removeSaved?: boolean },
) {
  const session = removeEnvironmentSession(environmentId);
  notifyEnvironmentConnectionListeners();
  await session?.connection.dispose();
  terminalMetadataUnsubscribers.get(environmentId)?.();
  terminalMetadataUnsubscribers.delete(environmentId);
  if (!options?.preserveShellSnapshot) {
    shellSnapshotManager.invalidate({ environmentId });
  }
  invalidateSourceControlDiscoveryForEnvironment(environmentId);
  terminalSessionManager.invalidateEnvironment(environmentId);
  environmentRuntimeManager.invalidate({ environmentId });

  if (options?.removeSaved) {
    await clearSavedConnection(environmentId);
    await clearCachedShellSnapshot(environmentId);
    clearCachedShellSnapshotMetadata(environmentId);
    removeSavedConnection(environmentId);
  }
}

export async function connectSavedEnvironment(
  connection: SavedRemoteConnection,
  options?: { readonly persist?: boolean },
) {
  await disconnectEnvironment(connection.environmentId, { preserveShellSnapshot: true });

  if (options?.persist !== false) {
    await saveConnection(connection);
  }

  upsertSavedConnection(connection);
  setEnvironmentConnectionStatus(connection.environmentId, "connecting", null);
  shellSnapshotManager.markPending({ environmentId: connection.environmentId });
  let lastHeartbeatTimeoutReconnectAt = 0;
  let environmentConnection: ReturnType<typeof createEnvironmentConnection> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectInFlight = false;

  const isCurrentEnvironmentConnection = () =>
    listEnvironmentSessions().some((session) => session.connection === environmentConnection);

  const reconnectEnvironment = (reason: string, failureMessage: string) => {
    if (reconnectInFlight || !isCurrentEnvironmentConnection()) {
      return;
    }

    reconnectInFlight = true;
    terminalDebugLog("registry:auto-reconnect", {
      environmentId: connection.environmentId,
      reason,
    });
    setEnvironmentConnectionStatus(connection.environmentId, "reconnecting", null);
    void environmentConnection
      ?.reconnect()
      .catch((error) => {
        setEnvironmentConnectionStatus(
          connection.environmentId,
          "disconnected",
          error instanceof Error ? error.message : failureMessage,
        );
      })
      .finally(() => {
        reconnectInFlight = false;
      });
  };

  const scheduleReconnect = (reason: string, failureMessage: string) => {
    if (reconnectTimer !== null || reconnectInFlight || !isCurrentEnvironmentConnection()) {
      return;
    }

    setEnvironmentConnectionStatus(connection.environmentId, "reconnecting", null);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnectEnvironment(reason, failureMessage);
    }, SOCKET_CLOSE_RECONNECT_DELAY_MS);
  };

  const reconnectAfterHeartbeatTimeout = () => {
    const now = Date.now();
    if (now - lastHeartbeatTimeoutReconnectAt < HEARTBEAT_TIMEOUT_RECONNECT_COOLDOWN_MS) {
      return;
    }

    lastHeartbeatTimeoutReconnectAt = now;
    reconnectEnvironment("heartbeat timeout", "Remote connection heartbeat timed out.");
  };

  const transport = new WsTransport(
    () =>
      resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: connection.wsBaseUrl,
        httpBaseUrl: connection.httpBaseUrl,
        bearerToken: connection.bearerToken,
      }),
    {
      onAttempt: () => {
        environmentRuntimeManager.patch({ environmentId: connection.environmentId }, (previous) => {
          const nextState =
            previous.connectionState === "ready" || previous.connectionState === "reconnecting"
              ? "reconnecting"
              : "connecting";
          const keepSettledFailure =
            previous.connectionState === "disconnected" && previous.connectionError !== null;
          return {
            ...previous,
            connectionState: keepSettledFailure ? "disconnected" : nextState,
            connectionError: keepSettledFailure ? previous.connectionError : null,
          };
        });
      },
      onError: (message) => {
        setEnvironmentConnectionStatus(connection.environmentId, "disconnected", message);
      },
      onClose: (details, context) => {
        if (context.intentional) {
          return;
        }

        const reason =
          details.reason.trim().length > 0
            ? details.reason
            : details.code === 1000
              ? null
              : `Remote connection closed (${details.code}).`;
        scheduleReconnect("socket close", reason ?? "Remote connection closed.");
      },
      onHeartbeatTimeout: reconnectAfterHeartbeatTimeout,
    },
  );

  const client = createWsRpcClient(transport);
  environmentConnection = createEnvironmentConnection({
    kind: "saved",
    knownEnvironment: {
      ...createKnownEnvironment({
        id: connection.environmentId,
        label: connection.environmentLabel,
        source: "manual",
        target: {
          httpBaseUrl: connection.httpBaseUrl,
          wsBaseUrl: connection.wsBaseUrl,
        },
      }),
      environmentId: connection.environmentId,
    },
    client,
    applyShellEvent: (event, environmentId) => {
      shellSnapshotManager.applyEvent({ environmentId }, event);
    },
    syncShellSnapshot: (snapshot, environmentId) => {
      shellSnapshotManager.syncSnapshot({ environmentId }, snapshot);
      markShellSnapshotLive(environmentId);
      void saveCachedShellSnapshot(environmentId, snapshot);
      environmentRuntimeManager.patch({ environmentId }, (runtime) => ({
        ...runtime,
        connectionState: "ready",
        connectionError: null,
      }));
    },
    onShellResubscribe: (environmentId) => {
      shellSnapshotManager.markPending({ environmentId });
    },
    onConfigSnapshot: (serverConfig) => {
      environmentRuntimeManager.patch({ environmentId: connection.environmentId }, (runtime) => ({
        ...runtime,
        serverConfig,
      }));
    },
  });

  setEnvironmentSession(connection.environmentId, {
    client,
    connection: environmentConnection,
  });
  terminalMetadataUnsubscribers.set(
    connection.environmentId,
    subscribeTerminalMetadata({
      environmentId: connection.environmentId,
      client,
    }),
  );
  terminalDebugLog("registry:terminal-metadata-subscribed", {
    environmentId: connection.environmentId,
  });
  notifyEnvironmentConnectionListeners();

  try {
    await withTimeout(
      environmentConnection.ensureBootstrapped(),
      SAVED_CONNECTION_BOOTSTRAP_TIMEOUT_MS,
      "Environment did not respond before the connection timeout.",
    );
  } catch (error) {
    setEnvironmentConnectionStatus(
      connection.environmentId,
      "disconnected",
      error instanceof Error ? error.message : "Failed to bootstrap remote connection.",
    );
  }
}

const environmentsSortOrder = Order.mapInput(
  Order.Struct({
    environmentLabel: Order.String,
  }),
  (environment: ConnectedEnvironmentSummary) => ({
    environmentLabel: environment.environmentLabel,
  }),
);

function deriveConnectedEnvironments(
  savedConnectionsById: Record<string, SavedRemoteConnection>,
  environmentStateById: Record<EnvironmentId, EnvironmentRuntimeState>,
): ReadonlyArray<ConnectedEnvironmentSummary> {
  return Arr.sort(
    Object.values(savedConnectionsById).map((connection) => {
      const runtime = environmentStateById[connection.environmentId];
      return {
        environmentId: connection.environmentId,
        environmentLabel: connection.environmentLabel,
        displayUrl: connection.displayUrl,
        connectionState: runtime?.connectionState ?? "idle",
        connectionError: runtime?.connectionError ?? null,
      };
    }),
    environmentsSortOrder,
  );
}

export function useRemoteEnvironmentBootstrap() {
  useEffect(() => {
    let cancelled = false;
    const unsubscribeAppResumeReconnects = subscribeAppResumeReconnects();

    void loadSavedConnections()
      .then((connections) => {
        if (cancelled) {
          return;
        }

        replaceSavedConnections(
          Object.fromEntries(
            connections.map((connection) => [connection.environmentId, connection]),
          ),
        );

        setIsLoadingSavedConnection(false);

        void (async () => {
          await Promise.all(
            connections.map(async (connection) => {
              const cached = await loadCachedShellSnapshot(connection.environmentId);
              if (!cancelled && cached) {
                hydrateCachedShellSnapshot(cached);
              }
            }),
          );

          if (cancelled) {
            return;
          }

          await Promise.all(
            connections.map((connection) =>
              connectSavedEnvironment(connection, {
                persist: false,
              }),
            ),
          );
        })();
      })
      .catch(() => {
        if (!cancelled) {
          setIsLoadingSavedConnection(false);
        }
      });

    return () => {
      cancelled = true;
      unsubscribeAppResumeReconnects();
      for (const session of drainEnvironmentSessions()) {
        void session.connection.dispose();
      }
      for (const unsubscribe of terminalMetadataUnsubscribers.values()) {
        unsubscribe();
      }
      terminalMetadataUnsubscribers.clear();
      environmentRuntimeManager.invalidate();
      shellSnapshotManager.invalidate();
      resetSourceControlDiscoveryState();
      terminalSessionManager.invalidate();
      notifyEnvironmentConnectionListeners();
    };
  }, []);
}

export function useRemoteEnvironmentState() {
  const state = useRemoteEnvironmentLocalState();
  const environmentStateById = useEnvironmentRuntimeStates(
    Object.values(state.savedConnectionsById).map((connection) => connection.environmentId),
  );

  return useMemo(
    () => ({
      ...state,
      environmentStateById,
    }),
    [environmentStateById, state],
  );
}

export function useRemoteConnectionStatus() {
  const { environmentStateById, pendingConnectionError, savedConnectionsById } =
    useRemoteEnvironmentState();

  const connectedEnvironments = useMemo(
    () => deriveConnectedEnvironments(savedConnectionsById, environmentStateById),
    [environmentStateById, savedConnectionsById],
  );

  const connectionState = useMemo<EnvironmentConnectionState>(() => {
    if (connectedEnvironments.length === 0) {
      return "idle";
    }
    if (connectedEnvironments.some((environment) => environment.connectionState === "ready")) {
      return "ready";
    }
    if (
      connectedEnvironments.some((environment) => environment.connectionState === "reconnecting")
    ) {
      return "reconnecting";
    }
    if (connectedEnvironments.some((environment) => environment.connectionState === "connecting")) {
      return "connecting";
    }
    return "disconnected";
  }, [connectedEnvironments]);

  const connectionError = useMemo(
    () =>
      pipe(
        Arr.appendAll(
          [pendingConnectionError],
          Arr.map(connectedEnvironments, (environment) => environment.connectionError),
        ),
        Arr.findFirst((value) => value !== null),
        Option.getOrNull,
      ),
    [connectedEnvironments, pendingConnectionError],
  );

  return {
    connectedEnvironments,
    connectionState,
    connectionError,
  };
}

export function useRemoteConnections() {
  const { connectionPairingUrl, pendingConnectionError } = useRemoteEnvironmentState();
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();

  const onConnectPress = useCallback(
    async (pairingUrl?: string) => {
      try {
        const nextPairingUrl = pairingUrl ?? connectionPairingUrl;
        const connection = await bootstrapRemoteConnection({ pairingUrl: nextPairingUrl });
        clearPendingConnectionError();
        await connectSavedEnvironment(connection);
        clearConnectionPairingUrl();
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to pair with the environment.",
        );
        throw error;
      }
    },
    [connectionPairingUrl],
  );

  const onUpdateEnvironment = useCallback(
    async (
      environmentId: EnvironmentId,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      const connection = getSavedConnectionsById()[environmentId];
      if (!connection) {
        return;
      }

      const updated: SavedRemoteConnection = {
        ...connection,
        environmentLabel: updates.label.trim() || connection.environmentLabel,
        displayUrl: updates.displayUrl.trim() || connection.displayUrl,
      };

      await saveConnection(updated);
      upsertSavedConnection(updated);
    },
    [],
  );

  const onReconnectEnvironment = useCallback((environmentId: EnvironmentId) => {
    const connection = getSavedConnectionsById()[environmentId];
    if (!connection) {
      return;
    }
    void connectSavedEnvironment(connection, { persist: false });
  }, []);

  const onRemoveEnvironmentPress = useCallback((environmentId: EnvironmentId) => {
    const connection = getSavedConnectionsById()[environmentId];
    if (!connection) {
      return;
    }

    Alert.alert(
      "Remove environment?",
      `Disconnect and forget ${connection.environmentLabel} on this device.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void disconnectEnvironment(environmentId, { removeSaved: true });
          },
        },
      ],
    );
  }, []);

  return {
    connectionPairingUrl,
    connectionState,
    connectionError,
    pairingConnectionError: pendingConnectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onChangeConnectionPairingUrl: setConnectionPairingUrl,
    onConnectPress,
    onReconnectEnvironment,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}
