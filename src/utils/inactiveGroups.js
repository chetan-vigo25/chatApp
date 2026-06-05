/**
 * inactiveGroups
 *
 * Lightweight cross-module registry of group IDs the current user has left or
 * been removed from. The source of truth lives in RealtimeChatContext
 * (state.inactiveGroupIds); this module mirrors it so non-React modules — most
 * importantly the FCM background message handler, which runs in its own headless
 * JS context — can suppress notifications for groups the user is no longer in.
 *
 * Foreground reads use the in-memory cache (sync). The background handler may be
 * a cold start with no cache, so it falls back to AsyncStorage.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'inactive_group_ids';

let cache = {};
let hydrated = false;

// Replace the registry (called by RealtimeChatContext whenever the set changes).
export const setInactiveGroupIds = (map) => {
  cache = map && typeof map === 'object' ? { ...map } : {};
  hydrated = true;
  // Persist just the ids so a cold-start background handler can read them.
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.keys(cache))).catch(() => {});
};

const hydrateFromStorage = async () => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    if (Array.isArray(ids)) {
      cache = ids.reduce((acc, id) => { acc[String(id)] = 1; return acc; }, {});
    }
  } catch {
    // ignore — treat as "no inactive groups"
  }
  hydrated = true;
};

// Synchronous check against the in-memory cache (foreground use).
export const isGroupInactiveSync = (groupId) => Boolean(groupId && cache[String(groupId)]);

// Async check that hydrates from storage on first use (background-handler safe).
export const isGroupInactive = async (groupId) => {
  if (!groupId) return false;
  if (!hydrated) await hydrateFromStorage();
  return Boolean(cache[String(groupId)]);
};
