import { useAtomValue } from "@effect/atom-react";
import { useEffect } from "react";

import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@t3tools/contracts";
import { loadClientSettings, saveClientSettings } from "../lib/storage";
import { appAtomRegistry } from "./atom-registry";
import { Atom } from "effect/unstable/reactivity";

const clientSettingsAtom = Atom.make<ClientSettings>(DEFAULT_CLIENT_SETTINGS).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:client-settings"),
);

let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

async function hydrateClientSettings(): Promise<void> {
  if (hydrated) {
    return;
  }
  if (hydrationPromise) {
    return hydrationPromise;
  }

  hydrationPromise = loadClientSettings()
    .then((settings) => {
      appAtomRegistry.set(clientSettingsAtom, settings);
    })
    .catch((error) => {
      console.error("[mobile client settings] hydrate failed", error);
    })
    .finally(() => {
      hydrated = true;
      hydrationPromise = null;
    });

  return hydrationPromise;
}

export function getClientSettings(): ClientSettings {
  return appAtomRegistry.get(clientSettingsAtom);
}

export function updateClientSettings(patch: ClientSettingsPatch): void {
  const next = {
    ...appAtomRegistry.get(clientSettingsAtom),
    ...patch,
  };
  appAtomRegistry.set(clientSettingsAtom, next);
  void saveClientSettings(next).catch((error) => {
    console.error("[mobile client settings] persist failed", error);
  });
}

export function useClientSettings(): ClientSettings {
  useEffect(() => {
    void hydrateClientSettings();
  }, []);

  return useAtomValue(clientSettingsAtom);
}
