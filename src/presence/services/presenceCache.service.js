import AsyncStorage from '@react-native-async-storage/async-storage';
import { PRESENCE_CACHE_TTL, PRESENCE_STORAGE_KEYS } from '../constants';

const now = () => Date.now();

const wrapValue = (value) => ({ value, cachedAt: now() });

const isExpired = (entry, ttl = PRESENCE_CACHE_TTL) => {
  if (!entry || !entry.cachedAt) return true;
  return now() - Number(entry.cachedAt) > ttl;
};

const safeParse = (raw, fallback) => {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
};

export const cacheUserPresence = async (userId, presence) => {
  const raw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const map = safeParse(raw, {});
  map[userId] = wrapValue(presence);
  await AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.CONTACTS, JSON.stringify(map));
};

export const getCachedPresence = async (userId) => {
  const raw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const map = safeParse(raw, {});
  const entry = map[userId];
  if (!entry || isExpired(entry)) return null;
  return entry.value;
};

export const cacheMultiplePresence = async (presenceMap) => {
  const existingRaw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const existing = safeParse(existingRaw, {});
  const merged = { ...existing };

  Object.keys(presenceMap || {}).forEach((userId) => {
    merged[userId] = wrapValue(presenceMap[userId]);
  });

  await AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.CONTACTS, JSON.stringify(merged));
};

export const getAllCachedPresence = async () => {
  const raw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const map = safeParse(raw, {});
  const result = {};

  Object.keys(map).forEach((userId) => {
    if (!isExpired(map[userId])) {
      result[userId] = map[userId].value;
    }
  });

  return result;
};

export const clearExpiredCache = async () => {
  const raw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const map = safeParse(raw, {});
  const filtered = {};

  Object.keys(map).forEach((userId) => {
    if (!isExpired(map[userId])) {
      filtered[userId] = map[userId];
    }
  });

  await AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.CONTACTS, JSON.stringify(filtered));
};

export const updateLastSeen = async (userId) => {
  const current = await getCachedPresence(userId);
  if (!current) return;
  await cacheUserPresence(userId, {
    ...current,
    status: 'offline',
    lastSeen: now(),
    lastUpdated: now(),
  });
};

export const getLastSyncTimestamp = async () => {
  const value = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.LAST_SYNC);
  return value ? Number(value) : null;
};

export const setLastSyncTimestamp = async (timestamp = now()) => {
  await AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.LAST_SYNC, String(timestamp));
};

export const mergePresenceUpdate = async (userId, partialPresence) => {
  const current = (await getCachedPresence(userId)) || {};
  await cacheUserPresence(userId, {
    ...current,
    ...partialPresence,
    lastUpdated: now(),
  });
};

export const invalidateUserCache = async (userId) => {
  const raw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const map = safeParse(raw, {});
  delete map[userId];
  await AsyncStorage.setItem(PRESENCE_STORAGE_KEYS.CONTACTS, JSON.stringify(map));
};

export const warmCacheForContacts = async (userIds = []) => {
  const raw = await AsyncStorage.getItem(PRESENCE_STORAGE_KEYS.CONTACTS);
  const map = safeParse(raw, {});
  const warm = {};

  userIds.forEach((userId) => {
    if (map[userId] && !isExpired(map[userId])) {
      warm[userId] = map[userId].value;
    }
  });

  return warm;
};