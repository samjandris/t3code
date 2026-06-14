import { useCallback, useEffect, useState } from "react";

import type { ModelFavorite } from "../../lib/modelOptions";
import { favoriteKey } from "../../lib/modelOptions";
import { loadPreferences, savePreferencesPatch } from "../../lib/storage";

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
  const [favorites, setFavorites] = useState<ReadonlyArray<ModelFavorite>>([]);
  const [hasLoadedFavorites, setHasLoadedFavorites] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void loadPreferences()
      .then((preferences) => {
        if (cancelled) {
          return;
        }
        setFavorites(normalizeFavorites(preferences.modelFavorites ?? []));
        setHasLoadedFavorites(true);
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setHasLoadedFavorites(true);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const updateFavorites = useCallback((nextFavorites: ReadonlyArray<ModelFavorite>) => {
    const normalized = normalizeFavorites(nextFavorites);
    setFavorites(normalized);
    void savePreferencesPatch({ modelFavorites: normalized }).catch(() => {
      // Preferences are local convenience state. Keep the optimistic UI and
      // recover from storage failures on the next app launch.
    });
  }, []);

  return {
    favorites,
    hasLoadedFavorites,
    updateFavorites,
  };
}
