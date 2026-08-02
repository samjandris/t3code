import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import type { ModelFavorite } from "../../lib/modelOptions";
import { favoriteKey } from "../../lib/modelOptions";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

function normalizeFavorites(favorites: ReadonlyArray<ModelFavorite>): ModelFavorite[] {
  const normalized: ModelFavorite[] = [];
  const seen = new Set<string>();
  for (const favorite of favorites) {
    const provider = favorite.provider.trim();
    const model = favorite.model.trim();
    if (!provider || !model) {
      continue;
    }
    const key = favoriteKey({ provider, model });
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({ provider, model });
  }
  return normalized;
}

export function useMobileModelFavorites() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const favorites = useMemo(
    () =>
      normalizeFavorites(
        AsyncResult.isSuccess(preferencesResult)
          ? (preferencesResult.value.modelFavorites ?? [])
          : [],
      ),
    [preferencesResult],
  );
  const hasLoadedFavorites = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;

  const updateFavorites = useCallback(
    (nextFavorites: ReadonlyArray<ModelFavorite>) => {
      savePreferences({ modelFavorites: normalizeFavorites(nextFavorites) });
    },
    [savePreferences],
  );

  return {
    favorites,
    hasLoadedFavorites,
    updateFavorites,
  };
}
