import { useState, useEffect, useCallback, useRef } from 'react';
import { useContacts } from './ContactContext';
import { useNetwork } from './NetworkContext';
import { getSocket } from '../Redux/Services/Socket/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDeviceInfo } from './DeviceInfoContext';
import contactHasher from '../Redux/Services/Contact/ContactHasher';

const STORAGE_KEYS = {
  CONTACT_SYNC_STATE: '@contact_sync_state_v2',
  MATCHED_CONTACTS: '@matched_contacts',
  LAST_SYNC: '@last_contact_sync',
  HASHED_CONTACTS: '@hashed_contacts',
  DEVICE_ID: '@device_id',
  LAST_SYNC_SESSION: '@last_sync_session',
  INITIAL_SYNC_DONE: '@initial_sync_done',
  PENDING_REFRESH: '@pending_contact_refresh'
};

const UPDATE_HIGHLIGHT_MS = 24 * 60 * 60 * 1000;

const EMPTY_SYNC_STATE = {
  contacts: [],
  syncMetadata: {
    syncSessionId: null,
    syncedAt: null,
    expiresIn: null,
    expiresAt: null,
    stats: {
      totalContacts: 0,
      registeredCount: 0,
      unregisteredCount: 0,
      blockedCount: 0,
      invalidContacts: 0,
      changesCount: 0
    },
    lastFullSync: null,
    lastRefreshAttempt: null,
    lastRefreshedAt: null,
    lastSyncStatus: null
  },
  indexes: {
    byHash: {},
    byUserId: {},
    byOriginalId: {}
  }
};

const clampNumber = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const parseExpiresInToMs = (expiresIn) => {
  if (!expiresIn) return 0;

  if (typeof expiresIn === 'number') {
    return expiresIn > 1e12 ? Math.max(expiresIn - Date.now(), 0) : expiresIn;
  }

  const text = String(expiresIn).trim().toLowerCase();
  const directTs = Number(text);
  if (Number.isFinite(directTs)) {
    return directTs > 1e12 ? Math.max(directTs - Date.now(), 0) : Math.max(directTs, 0);
  }

  const match = text.match(/(\d+)\s*(second|seconds|minute|minutes|hour|hours|day|days|week|weeks)/);
  if (!match) return 0;

  const amount = clampNumber(match[1], 0);
  const unit = match[2];

  if (unit.startsWith('second')) return amount * 1000;
  if (unit.startsWith('minute')) return amount * 60 * 1000;
  if (unit.startsWith('hour')) return amount * 60 * 60 * 1000;
  if (unit.startsWith('day')) return amount * 24 * 60 * 60 * 1000;
  if (unit.startsWith('week')) return amount * 7 * 24 * 60 * 60 * 1000;
  return 0;
};

const buildIndexes = (contacts = []) => {
  const byHash = {};
  const byUserId = {};
  const byOriginalId = {};

  contacts.forEach((contact, index) => {
    if (contact?.hash) byHash[contact.hash] = index;
    if (contact?.userId) byUserId[contact.userId] = index;
    if (contact?.originalId) byOriginalId[contact.originalId] = index;
  });

  return { byHash, byUserId, byOriginalId };
};

const computeStats = (contacts = [], patchStats = null) => {
  const registeredCount = contacts.filter(c => c?.type === 'registered' || !!c?.userId).length;
  const unregisteredCount = contacts.length - registeredCount;
  const blockedCount = contacts.filter(c => !!c?.isBlocked).length;

  return {
    totalContacts: contacts.length,
    registeredCount,
    unregisteredCount,
    blockedCount,
    invalidContacts: 0,
    changesCount: clampNumber(patchStats?.changesCount, 0),
    ...patchStats
  };
};

const isMetadataExpired = (syncMetadata) => {
  if (!syncMetadata?.expiresAt) return true;
  return Date.now() >= Number(syncMetadata.expiresAt);
};

const dedupeByHashOrId = (contacts = []) => {
  const seen = new Set();
  const list = [];

  for (const contact of contacts) {
    const key = contact?.hash || contact?.userId || contact?.originalId;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    list.push(contact);
  }

  return list;
};

export const useContactSync = () => {
  const { contacts: deviceContacts = [], askPermissionAndLoadContacts } = useContacts();
  const { isConnected } = useNetwork();
  const socket = getSocket();
  const deviceInfo = useDeviceInfo?.() || {};

  const mountedRef = useRef(true);
  const bootstrappedRef = useRef(false);
  const screenOpenSyncInProgressRef = useRef(false);

  const [matchedContacts, setMatchedContacts] = useState([]);
  const [matchedRegistered, setMatchedRegistered] = useState([]);
  const [matchedUnregistered, setMatchedUnregistered] = useState([]);
  const [hashedContacts, setHashedContacts] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isBackgroundRefreshing, setIsBackgroundRefreshing] = useState(false);
  const [isExpiredUpdating, setIsExpiredUpdating] = useState(false);
  const [error, setError] = useState(null);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [discoverResponse, setDiscoverResponse] = useState(null);
  const [inviteResponse, setInviteResponse] = useState(null);
  const [lastSyncSessionId, setLastSyncSessionId] = useState(null);
  const [syncMetadata, setSyncMetadata] = useState(EMPTY_SYNC_STATE.syncMetadata);
  const [syncState, setSyncState] = useState(EMPTY_SYNC_STATE);
  const [changes, setChanges] = useState({ added: [], updated: [], removed: [], statusChanged: [] });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const getDeviceId = useCallback(async () => {
    try {
      const id = await AsyncStorage.getItem(STORAGE_KEYS.DEVICE_ID);
      return id;
    } catch (err) {
      console.error('useContactSync:getDeviceId error:', err);
      return null;
    }
  }, []);

  const getClientInfo = useCallback(async () => {
    const storedDeviceId = await getDeviceId();
    return {
      deviceId: storedDeviceId || 'unknown_device',
      appVersion: deviceInfo?.appVersion || 'unknown_version',
      os: deviceInfo?.osName || 'unknown_os',
      osVersion: deviceInfo?.version || 'unknown_os_version',
      deviceModel: deviceInfo?.modelName || 'unknown_model',
    };
  }, [deviceInfo, getDeviceId]);

  const buildLocalHashMap = useCallback(() => {
    const localHashMap = {};

    for (const localContact of (deviceContacts || [])) {
      try {
        const phone = localContact?.phoneNumbers?.[0]?.number || localContact?.phoneNumber || null;
        if (!phone) continue;
        const hashed = contactHasher.hashPhoneNumber(String(phone));
        if (!hashed?.hash) continue;

        localHashMap[hashed.hash] = {
          originalId: localContact?.id || null,
          originalPhone: phone,
          normalizedPhone: hashed?.normalized || null,
          localName: localContact?.name || null
        };
      } catch {
      }
    }

    return localHashMap;
  }, [deviceContacts]);

  const normalizeIncomingContacts = useCallback((incoming = []) => {
    const localHashMap = buildLocalHashMap();
    return incoming
      .filter(Boolean)
      .map((contact) => {
        const hash = contact?.hash || null;
        const localMapEntry = hash ? localHashMap[hash] : null;
        const fullName = contact?.fullName || contact?.name || contact?.displayName || localMapEntry?.localName || '';

        return {
          originalId: contact?.originalId || localMapEntry?.originalId || contact?.id || null,
          hash,
          encryptNumber: contact?.encryptNumber || null,

          type: (contact?.type || (contact?.userId ? 'registered' : 'unregistered')).toLowerCase(),
          userId: contact?.userId || null,
          fullName,
          name: fullName,
          email: contact?.email || null,
          mobile: contact?.mobile || {
            code: null,
            number: contact?.phone || contact?.number || localMapEntry?.originalPhone || null
          },
          mobileFormatted: contact?.mobileFormatted || contact?.phone || contact?.number || localMapEntry?.originalPhone || '',
          profileImage: contact?.profileImage || contact?.profilePicture || contact?.avatar || '',
          profilePicture: contact?.profileImage || contact?.profilePicture || contact?.avatar || '',
          about: contact?.about || '',
          isActive: !!contact?.isActive,
          lastLogin: contact?.lastLogin || null,
          canMessage: contact?.canMessage ?? !!contact?.userId,
          isBlocked: !!contact?.isBlocked,

          hashDetails: {
            algorithm: contact?.hashDetails?.algorithm || contact?.algorithm || null,
            salt: contact?.hashDetails?.salt || contact?.salt || null
          },

          isFavorite: !!contact?.isFavorite,
          lastContacted: contact?.lastContacted || null,
          localProfileImage: contact?.localProfileImage || null,

          isNewUntil: contact?.isNewUntil || null,
          updatedHighlightUntil: contact?.updatedHighlightUntil || null,
          joinedWhatsAppAt: contact?.joinedWhatsAppAt || null,

          originalPhone: contact?.originalPhone || localMapEntry?.originalPhone || null,
          normalizedPhone: contact?.normalizedPhone || localMapEntry?.normalizedPhone || null,
          _raw: contact
        };
      });
  }, [buildLocalHashMap]);

  const applyContactsToState = useCallback((contactsList = [], metadataPatch = null) => {
    const deduped = dedupeByHashOrId(contactsList);
    const registered = deduped.filter(c => c.type === 'registered' || !!c.userId);
    const unregistered = deduped.filter(c => c.type !== 'registered' && !c.userId);

    const mergedMetadata = {
      ...syncMetadata,
      ...(metadataPatch || {}),
    };

    const nextState = {
      contacts: deduped,
      syncMetadata: {
        ...mergedMetadata,
        stats: computeStats(deduped, metadataPatch?.stats || mergedMetadata?.stats)
      },
      indexes: buildIndexes(deduped)
    };

    if (mountedRef.current) {
      setMatchedContacts(deduped);
      setMatchedRegistered(registered);
      setMatchedUnregistered(unregistered);
      setLastSyncSessionId(nextState.syncMetadata.syncSessionId || null);
      setLastSyncTime(nextState.syncMetadata.syncedAt ? new Date(nextState.syncMetadata.syncedAt) : null);
      setSyncMetadata(nextState.syncMetadata);
      setSyncState(nextState);
    }

    return nextState;
  }, [syncMetadata]);

  const persistSyncState = useCallback(async (nextState) => {
    const payload = JSON.stringify(nextState);
    await AsyncStorage.setItem(STORAGE_KEYS.CONTACT_SYNC_STATE, payload);

    await AsyncStorage.multiSet([
      [STORAGE_KEYS.MATCHED_CONTACTS, JSON.stringify(nextState.contacts || [])],
      [STORAGE_KEYS.LAST_SYNC, nextState.syncMetadata?.syncedAt ? new Date(nextState.syncMetadata.syncedAt).toISOString() : ''],
      [STORAGE_KEYS.LAST_SYNC_SESSION, nextState.syncMetadata?.syncSessionId || ''],
      [STORAGE_KEYS.INITIAL_SYNC_DONE, String((nextState.contacts || []).length > 0)]
    ]);
  }, []);

  const loadContacts = useCallback(async () => {
    try {
      const [stateRaw, cachedHashed] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.CONTACT_SYNC_STATE),
        AsyncStorage.getItem(STORAGE_KEYS.HASHED_CONTACTS)
      ]);

      if (cachedHashed && mountedRef.current) {
        try {
          setHashedContacts(JSON.parse(cachedHashed));
        } catch {
        }
      }

      if (stateRaw) {
        const parsedState = JSON.parse(stateRaw);
        applyContactsToState(parsedState?.contacts || [], parsedState?.syncMetadata || {});
        return parsedState;
      }

      const [legacyMatched, legacyLastSync, legacySyncSession] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.MATCHED_CONTACTS),
        AsyncStorage.getItem(STORAGE_KEYS.LAST_SYNC),
        AsyncStorage.getItem(STORAGE_KEYS.LAST_SYNC_SESSION)
      ]);

      const legacyContacts = legacyMatched ? JSON.parse(legacyMatched) : [];
      if (!legacyContacts?.length) return EMPTY_SYNC_STATE;

      const syncedAt = legacyLastSync ? new Date(legacyLastSync).getTime() : null;
      const nextState = applyContactsToState(legacyContacts, {
        syncSessionId: legacySyncSession || null,
        syncedAt,
        lastFullSync: syncedAt,
        lastSyncStatus: 'legacy_loaded'
      });
      await persistSyncState(nextState);
      return nextState;
    } catch (err) {
      console.error('useContactSync: loadContacts error:', err);
      return EMPTY_SYNC_STATE;
    }
  }, [applyContactsToState, persistSyncState]);

  const ensureDeviceContactsLoaded = useCallback(async () => {
    if (Array.isArray(deviceContacts) && deviceContacts.length > 0) return true;

    try {
      await askPermissionAndLoadContacts?.();
    } catch (err) {
      console.warn('useContactSync: askPermissionAndLoadContacts failed', err);
    }

    return Array.isArray(deviceContacts) && deviceContacts.length > 0;
  }, [deviceContacts, askPermissionAndLoadContacts]);

  const getHashedContacts = useCallback(async () => {
    const contactsExist = await ensureDeviceContactsLoaded();
    if (!contactsExist && (!deviceContacts || deviceContacts.length === 0)) {
      return [];
    }

    const hashed = contactHasher.hashContactList(deviceContacts || []);
    const valid = hashed.filter(contact => contactHasher.validateHashedContact(contact));

    if (mountedRef.current) setHashedContacts(valid);
    await AsyncStorage.setItem(STORAGE_KEYS.HASHED_CONTACTS, JSON.stringify(valid));
    return valid;
  }, [deviceContacts, ensureDeviceContactsLoaded]);

  const emitWithAckAndEvent = useCallback((eventName, payload, responseEvent, timeoutMs = 25000) => {
    if (!socket?.emit) return Promise.reject(new Error('Socket not available'));

    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (responseEvent) socket?.off?.(responseEvent, responseHandler);
        reject(new Error(`${eventName}: timeout`));
      }, timeoutMs);

      const finish = (data, isError = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (responseEvent) socket?.off?.(responseEvent, responseHandler);
        if (isError) reject(data instanceof Error ? data : new Error(String(data || 'Request failed')));
        else resolve(data);
      };

      const responseHandler = (data) => {
        finish(data, false);
      };

      if (responseEvent) {
        socket?.once?.(responseEvent, responseHandler);
      }

      socket.emit(eventName, payload, (ack) => {
        if (ack?.error || ack?.status === false) {
          finish(new Error(ack?.error || ack?.message || `${eventName} failed`), true);
          return;
        }

        if (ack && (ack.data || ack.status === true)) {
          finish(ack, false);
        }
      });
    });
  }, [socket]);

  const parseSyncResponse = useCallback((payload) => {
    const source = payload?.data ? payload.data : payload;
    const contactsData = source?.contacts || source?.matches || [];

    if (!Array.isArray(contactsData)) {
      throw new Error('Invalid sync response: contacts is not an array');
    }

    return {
      syncSessionId: source?.syncSessionId || payload?.syncSessionId || null,
      contacts: contactsData,
      expiresIn: source?.expiresIn || payload?.expiresIn || null,
      refreshedAt: source?.refreshedAt || source?.syncedAt || payload?.timestamp || Date.now(),
      stats: source?.stats || null,
      changes: source?.changes || { added: [], updated: [], removed: [], statusChanged: [] }
    };
  }, []);

  const mergeRefreshDelta = useCallback((existingContacts = [], incomingContacts = [], incomingChanges = null) => {
    const map = new Map();

    for (const item of existingContacts) {
      const key = item?.hash || item?.userId || item?.originalId;
      if (!key) continue;
      map.set(key, item);
    }

    const now = Date.now();

    for (const incoming of incomingContacts) {
      const key = incoming?.hash || incoming?.userId || incoming?.originalId;
      if (!key) continue;
      const prev = map.get(key);

      if (!prev) {
        map.set(key, {
          ...incoming,
          isNewUntil: now + UPDATE_HIGHLIGHT_MS,
          updatedHighlightUntil: now + UPDATE_HIGHLIGHT_MS,
          joinedWhatsAppAt: incoming?.type === 'registered' ? now : null
        });
        continue;
      }

      const typeChangedToRegistered = prev?.type !== 'registered' && incoming?.type === 'registered';
      map.set(key, {
        ...prev,
        ...incoming,
        updatedHighlightUntil: now + UPDATE_HIGHLIGHT_MS,
        joinedWhatsAppAt: typeChangedToRegistered ? now : prev?.joinedWhatsAppAt || null,
        isNewUntil: prev?.isNewUntil || null
      });
    }

    const removedHashes = incomingChanges?.removed || [];
    for (const hash of removedHashes) {
      map.delete(hash);
    }

    return Array.from(map.values());
  }, []);

  const withRetry = useCallback(async (fn, retries = 3) => {
    let errorRef = null;
    for (let i = 0; i < retries; i += 1) {
      try {
        return await fn();
      } catch (err) {
        errorRef = err;
        if (i === retries - 1) break;
        const waitMs = Math.min(3000, 500 * (2 ** i));
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
    throw errorRef || new Error('Operation failed');
  }, []);

  const runFullSync = useCallback(async ({ reason = 'manual', silent = false } = {}) => {
    if (!socket?.emit) {
      throw new Error('Socket not available for full sync');
    }

    const hashed = await getHashedContacts();
    if (!hashed.length) {
      const emptyMetadata = {
        ...syncMetadata,
        lastSyncStatus: 'empty_device_contacts',
        lastRefreshAttempt: Date.now()
      };
      const nextState = applyContactsToState([], emptyMetadata);
      await persistSyncState(nextState);
      return nextState;
    }

    if (mountedRef.current) {
      setError(null);
      if (!silent) setIsSyncing(true);
    }

    try {
      const clientInfo = await getClientInfo();

      const payload = {
        contacts: hashed.map(contact => ({
          id: contact.id,
          originalId: contact.id,
          fullName: contact.fullName || contact.name || '',
          hash: contact.hash,
          salt: contact.salt,
          algorithm: contact.algorithm,
          encryptNumber: contact.encryptNumber || (
            contact.normalizedPhone && contact.salt
              ? contactHasher.encryptContent(contact.normalizedPhone + contact.salt)
              : null
          )
        })),
        clientInfo,
        syncOptions: { fullSync: true, overwrite: false },
      };

      const rawResponse = await withRetry(() =>
        emitWithAckAndEvent('contact:sync', payload, 'contact:sync:response'),
      3);

      const parsed = parseSyncResponse(rawResponse);
      const normalized = normalizeIncomingContacts(parsed.contacts);

      const refreshedAt = clampNumber(parsed.refreshedAt, Date.now());
      const expiresMs = parseExpiresInToMs(parsed.expiresIn);
      const expiresAt = expiresMs > 0 ? refreshedAt + expiresMs : null;

      const nextState = applyContactsToState(normalized, {
        syncSessionId: parsed.syncSessionId || syncMetadata?.syncSessionId || null,
        syncedAt: refreshedAt,
        expiresIn: parsed.expiresIn || syncMetadata?.expiresIn || null,
        expiresAt,
        stats: computeStats(normalized, parsed.stats || {}),
        lastFullSync: refreshedAt,
        lastRefreshAttempt: Date.now(),
        lastRefreshedAt: refreshedAt,
        lastSyncStatus: `full_sync_${reason}`
      });

      setChanges(parsed.changes || { added: [], updated: [], removed: [], statusChanged: [] });
      await persistSyncState(nextState);
      await AsyncStorage.removeItem(STORAGE_KEYS.PENDING_REFRESH);

      return nextState;
    } catch (err) {
      if (mountedRef.current) {
        setError(err?.message || 'Failed to sync contacts');
      }
      throw err;
    } finally {
      if (mountedRef.current) {
        setIsSyncing(false);
        setIsExpiredUpdating(false);
      }
    }
  }, [
    socket,
    getHashedContacts,
    syncMetadata,
    applyContactsToState,
    persistSyncState,
    getClientInfo,
    withRetry,
    emitWithAckAndEvent,
    parseSyncResponse,
    normalizeIncomingContacts
  ]);

  const runRefresh = useCallback(async ({
    reason = 'manual',
    silent = false,
    fallbackToSync = false,
    incremental = true
  } = {}) => {
    if (!socket?.emit) {
      throw new Error('Socket not available for refresh');
    }

    const sessionId = syncMetadata?.syncSessionId || lastSyncSessionId;
    if (!sessionId) {
      if (fallbackToSync) return runFullSync({ reason: 'refresh_no_session', silent });
      throw new Error('No sync session found for refresh');
    }

    if (mountedRef.current) {
      setError(null);
      if (silent) setIsBackgroundRefreshing(true);
      else setIsRefreshing(true);
    }

    try {
      const deviceId = await getDeviceId();

      const payload = {
        syncSessionId: sessionId,
        deviceId: deviceId || 'unknown_device',
        syncOptions: {
          incremental,
          includeStats: true,
          includeProfileImages: true
        }
      };

      const rawResponse = await withRetry(() =>
        emitWithAckAndEvent('contact:refresh', payload, 'contact:refresh:response'),
      3);

      const parsed = parseSyncResponse(rawResponse);
      const normalizedIncoming = normalizeIncomingContacts(parsed.contacts);

      const merged = mergeRefreshDelta(matchedContacts, normalizedIncoming, parsed.changes);
      const refreshedAt = clampNumber(parsed.refreshedAt, Date.now());
      const expiresMs = parseExpiresInToMs(parsed.expiresIn || syncMetadata?.expiresIn);
      const expiresAt = expiresMs > 0 ? refreshedAt + expiresMs : syncMetadata?.expiresAt || null;

      const nextState = applyContactsToState(merged, {
        syncSessionId: parsed.syncSessionId || sessionId,
        syncedAt: refreshedAt,
        expiresIn: parsed.expiresIn || syncMetadata?.expiresIn || null,
        expiresAt,
        stats: computeStats(merged, parsed.stats || {}),
        lastRefreshAttempt: Date.now(),
        lastRefreshedAt: refreshedAt,
        lastSyncStatus: `refresh_${reason}`
      });

      setChanges(parsed.changes || { added: [], updated: [], removed: [], statusChanged: [] });
      await persistSyncState(nextState);
      await AsyncStorage.removeItem(STORAGE_KEYS.PENDING_REFRESH);

      return nextState;
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      const invalidSession = msg.includes('session') || msg.includes('401') || msg.includes('unauthorized');

      if (invalidSession && fallbackToSync) {
        return runFullSync({ reason: 'invalid_session', silent });
      }

      if (mountedRef.current) {
        setError(err?.message || 'Failed to refresh contacts');
      }

      throw err;
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false);
        setIsBackgroundRefreshing(false);
      }
    }
  }, [
    socket,
    syncMetadata,
    lastSyncSessionId,
    getDeviceId,
    withRetry,
    emitWithAckAndEvent,
    parseSyncResponse,
    normalizeIncomingContacts,
    mergeRefreshDelta,
    matchedContacts,
    applyContactsToState,
    persistSyncState,
    runFullSync
  ]);

  const syncContacts = useCallback(async ({ reason = 'screen_open' } = {}) => {
    if (screenOpenSyncInProgressRef.current) return syncState;
    screenOpenSyncInProgressRef.current = true;

    try {
      const cachedState = await loadContacts();
      const hasCached = Array.isArray(cachedState?.contacts) && cachedState.contacts.length > 0;
      const expired = isMetadataExpired(cachedState?.syncMetadata || {});

      if (!isConnected) {
        if (!hasCached) {
          throw new Error('Offline and no cached contacts available');
        }
        await AsyncStorage.setItem(STORAGE_KEYS.PENDING_REFRESH, 'true');
        return cachedState;
      }

      if (!hasCached) {
        return await runFullSync({ reason: `${reason}_first_time`, silent: false });
      }

      if (expired) {
        if (mountedRef.current) setIsExpiredUpdating(true);
        return await runFullSync({ reason: `${reason}_expired`, silent: false });
      }

      runRefresh({ reason: `${reason}_silent`, silent: true, fallbackToSync: true, incremental: true })
        .catch((err) => console.warn('useContactSync: silent refresh failed', err?.message || err));

      return cachedState;
    } finally {
      screenOpenSyncInProgressRef.current = false;
    }
  }, [syncState, loadContacts, isConnected, runFullSync, runRefresh]);

  const refreshContacts = useCallback(async ({ fallbackToSync = true } = {}) => {
    if (!isConnected) {
      await AsyncStorage.setItem(STORAGE_KEYS.PENDING_REFRESH, 'true');
      throw new Error('Offline - refresh queued until connection restores');
    }

    const sessionId = syncMetadata?.syncSessionId || lastSyncSessionId;
    if (!sessionId) {
      return runFullSync({ reason: 'pull_to_refresh_no_session', silent: false });
    }

    return runRefresh({ reason: 'pull_to_refresh', silent: false, fallbackToSync, incremental: true });
  }, [isConnected, syncMetadata, lastSyncSessionId, runFullSync, runRefresh]);

  const processContacts = useCallback(async () => {
    setIsProcessing(true);
    try {
      return await runFullSync({ reason: 'process_contacts', silent: false });
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  }, [runFullSync]);

  const discoverContact = useCallback((contactHash) => {
    if (!socket?.emit || !contactHash) return Promise.reject(new Error('Invalid contact hash'));

    if (mountedRef.current) setIsSyncing(true);
    setDiscoverResponse(null);

    return new Promise((resolve, reject) => {
      let settled = false;
      const responseEvents = ['contact:discover:response', 'contactdiscover:response'];

      const cleanupListeners = () => {
        responseEvents.forEach((eventName) => {
          socket?.off?.(eventName, handleResponse);
        });
      };

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        if (mountedRef.current) setIsSyncing(false);
        reject(new Error('discoverContact: timeout'));
      }, 30000);

      const handleResponse = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanupListeners();
        if (mountedRef.current) {
          setDiscoverResponse(payload);
          setIsSyncing(false);
        }
        resolve(payload);
      };

      responseEvents.forEach((eventName) => {
        socket?.once?.(eventName, handleResponse);
      });
      socket.emit('contact:discover', { contactHash }, (ack) => {
        if (ack?.error && !settled) {
          settled = true;
          clearTimeout(timeout);
          cleanupListeners();
          if (mountedRef.current) setIsSyncing(false);
          setError(ack.error);
          reject(new Error(ack.error));
        }
      });
    });
  }, [socket]);

  const handleSenInvatation = useCallback((payload) => {
    if (!socket?.emit) {
      return Promise.reject(new Error('Socket not available'));
    }

    if (mountedRef.current) setError(null);

    return new Promise((resolve, reject) => {
      socket.emit('contact:invite', payload, (ack) => {
        if (ack?.error || ack?.status === false) {
          const err = new Error(ack?.error || ack?.message || 'Failed to send invitation');
          setError(err.message);
          reject(err);
          return;
        }

        if (mountedRef.current) {
          setInviteResponse(ack || { status: true, message: 'Invitation sent' });
        }
        resolve(ack || { status: true });
      });
    });
  }, [socket]);

  useEffect(() => {
    const bootstrap = async () => {
      if (bootstrappedRef.current) return;
      bootstrappedRef.current = true;
      await loadContacts();
    };

    bootstrap();
  }, [loadContacts]);

  useEffect(() => {
    if (!isConnected) return;

    const reconcilePendingRefresh = async () => {
      const pending = await AsyncStorage.getItem(STORAGE_KEYS.PENDING_REFRESH);
      if (pending === 'true') {
        try {
          await refreshContacts({ fallbackToSync: true });
        } catch (err) {
          console.warn('useContactSync: pending refresh failed', err?.message || err);
        }
      }
    };

    reconcilePendingRefresh();
  }, [isConnected, refreshContacts]);

  useEffect(() => {
    if (!socket?.on) return;

    const handleSyncError = (data) => {
      if (!mountedRef.current) return;
      setError(data?.message || data || 'Sync failed');
      setIsSyncing(false);
      setIsRefreshing(false);
      setIsBackgroundRefreshing(false);
    };

    const handleInviteResponse = (payload) => {
      if (!mountedRef.current) return;
      setInviteResponse(payload);
    };

    socket.on('contact:sync:error', handleSyncError);
    socket.on('invitesent:response', handleInviteResponse);

    return () => {
      socket?.off?.('contact:sync:error', handleSyncError);
      socket?.off?.('invitesent:response', handleInviteResponse);
    };
  }, [socket]);

  const clearDiscoverResponse = useCallback(() => {
    if (mountedRef.current) setDiscoverResponse(null);
  }, []);

  const clearInviteResponse = useCallback(() => {
    if (mountedRef.current) setInviteResponse(null);
  }, []);

  const hasCachedContacts = matchedContacts.length > 0;
  const isCacheExpired = isMetadataExpired(syncMetadata);

  return {
    matchedContacts,
    matchedRegistered,
    matchedUnregistered,
    hashedContacts,
    isProcessing,
    isSyncing,
    isRefreshing,
    isBackgroundRefreshing,
    isExpiredUpdating,
    error,
    lastSyncTime,
    discoverResponse,
    inviteResponse,
    totalContacts: deviceContacts.length,
    matchedCount: matchedContacts.length,
    discoverContact,
    clearDiscoverResponse,
    clearInviteResponse,
    syncContacts,
    processContacts,
    refreshContacts,
    loadContacts,
    handleSenInvatation,
    lastSyncSessionId,
    syncMetadata,
    changes,
    hasCachedContacts,
    isCacheExpired
  };
};

export default useContactSync;
