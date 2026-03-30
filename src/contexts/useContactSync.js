import { useState, useEffect, useCallback, useRef } from 'react';
import * as Contacts from 'expo-contacts';
import { useContacts } from './ContactContext';
import { useNetwork } from './NetworkContext';
import { getSocket } from '../Redux/Services/Socket/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDeviceInfo } from './DeviceInfoContext';
import contactHasher from '../Redux/Services/Contact/ContactHasher';
import ContactDatabase from '../services/ContactDatabase';

const STORAGE_KEYS = {
  DEVICE_ID: '@device_id',
  PENDING_REFRESH: '@pending_contact_refresh',
  HASHED_CONTACTS: '@hashed_contacts',
};

const UPDATE_HIGHLIGHT_MS = 24 * 60 * 60 * 1000;

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
  const [isInitialLoading, setIsInitialLoading] = useState(true); // true until first DB load completes
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
  const [syncMetadata, setSyncMetadata] = useState({});
  const [changes, setChanges] = useState({ added: [], updated: [], removed: [], statusChanged: [] });

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // ─── HELPERS ───

  const getDeviceId = useCallback(async () => {
    try { return await AsyncStorage.getItem(STORAGE_KEYS.DEVICE_ID); }
    catch { return null; }
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

  // Ref to hold the latest fresh device contacts (updated by getHashedContacts)
  const freshDeviceContactsRef = useRef([]);

  const buildLocalHashMap = useCallback(() => {
    // Use fresh device contacts if available, fall back to context
    const contacts = freshDeviceContactsRef.current.length > 0
      ? freshDeviceContactsRef.current
      : (deviceContacts || []);
    const localHashMap = {};
    for (const localContact of contacts) {
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
      } catch {}
    }
    return localHashMap;
  }, [deviceContacts]);

  const normalizeIncomingContacts = useCallback((incoming = []) => {
    const localHashMap = buildLocalHashMap();
    return incoming.filter(Boolean).map((contact) => {
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
        isNewUntil: contact?.isNewUntil || null,
        updatedHighlightUntil: contact?.updatedHighlightUntil || null,
        joinedWhatsAppAt: contact?.joinedWhatsAppAt || null,
        originalPhone: contact?.originalPhone || localMapEntry?.originalPhone || null,
        normalizedPhone: contact?.normalizedPhone || localMapEntry?.normalizedPhone || null,
      };
    });
  }, [buildLocalHashMap]);

  // ─── APPLY TO STATE FROM SQLITE ───

  const applyFromDB = useCallback(async () => {
    try {
      const all = await ContactDatabase.loadAllContacts();
      const registered = all.filter(c => c.type === 'registered' || !!c.userId);
      const unregistered = all.filter(c => c.type !== 'registered' && !c.userId);

      if (mountedRef.current) {
        setMatchedContacts(all);
        setMatchedRegistered(registered);
        setMatchedUnregistered(unregistered);
      }

      const sessionId = await ContactDatabase.getSyncSessionId();
      const lastSync = await ContactDatabase.getLastSyncTime();
      const metadata = await ContactDatabase.getSyncMetadata();

      if (mountedRef.current) {
        setLastSyncSessionId(sessionId);
        setLastSyncTime(lastSync ? new Date(lastSync) : null);
        setSyncMetadata(metadata || {});
      }

      return all;
    } catch (err) {
      console.warn('[useContactSync] applyFromDB error:', err?.message);
      return [];
    }
  }, []);

  // ─── HASHING ───

  /**
   * Read contacts FRESH from device every time. Don't rely on the stale
   * deviceContacts closure — it won't reflect numbers added after mount.
   */
  const readFreshDeviceContacts = useCallback(async () => {
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') return [];
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });
      const filtered = (data || []).filter(c => c.phoneNumbers?.length > 0);
      freshDeviceContactsRef.current = filtered; // save for buildLocalHashMap
      return filtered;
    } catch (err) {
      console.warn('[useContactSync] readFreshDeviceContacts error:', err?.message);
      return [];
    }
  }, []);

  const getHashedContacts = useCallback(async () => {
    // Always read fresh from device — this is the ONLY way to pick up newly added numbers
    const freshContacts = await readFreshDeviceContacts();
    if (freshContacts.length === 0) return [];

    const hashed = contactHasher.hashContactList(freshContacts);
    const valid = hashed.filter(contact => contactHasher.validateHashedContact(contact));
    if (mountedRef.current) setHashedContacts(valid);
    await AsyncStorage.setItem(STORAGE_KEYS.HASHED_CONTACTS, JSON.stringify(valid));
    return valid;
  }, [readFreshDeviceContacts]);

  // ─── SOCKET HELPERS ───

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

      const responseHandler = (data) => finish(data, false);

      if (responseEvent) socket?.once?.(responseEvent, responseHandler);

      socket.emit(eventName, payload, (ack) => {
        if (ack?.error || ack?.status === false) {
          finish(new Error(ack?.error || ack?.message || `${eventName} failed`), true);
          return;
        }
        if (ack && (ack.data || ack.status === true)) finish(ack, false);
      });
    });
  }, [socket]);

  const parseSyncResponse = useCallback((payload) => {
    const source = payload?.data ? payload.data : payload;
    const contactsData = source?.contacts || source?.matches || [];
    if (!Array.isArray(contactsData)) throw new Error('Invalid sync response');
    return {
      syncSessionId: source?.syncSessionId || payload?.syncSessionId || null,
      contacts: contactsData,
      expiresIn: source?.expiresIn || payload?.expiresIn || null,
      refreshedAt: source?.refreshedAt || source?.syncedAt || payload?.timestamp || Date.now(),
      stats: source?.stats || null,
      changes: source?.changes || { added: [], updated: [], removed: [], statusChanged: [] }
    };
  }, []);

  const withRetry = useCallback(async (fn, retries = 3) => {
    let errorRef = null;
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (err) {
        errorRef = err;
        if (i === retries - 1) break;
        await new Promise(r => setTimeout(r, Math.min(3000, 500 * (2 ** i))));
      }
    }
    throw errorRef || new Error('Operation failed');
  }, []);

  // ─── FULL SYNC (first time or expired) ───

  const runFullSync = useCallback(async ({ reason = 'manual', silent = false } = {}) => {
    if (!socket?.emit) throw new Error('Socket not available for full sync');

    const hashed = await getHashedContacts();
    if (!hashed.length) {
      await ContactDatabase.setSyncMetadata({ lastSyncStatus: 'empty_device_contacts' });
      await applyFromDB();
      return;
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

      const rawResponse = await withRetry(
        () => emitWithAckAndEvent('contact:sync', payload, 'contact:sync:response'),
        3
      );

      const parsed = parseSyncResponse(rawResponse);
      const normalized = normalizeIncomingContacts(parsed.contacts);
      const deduped = dedupeByHashOrId(normalized);

      // Write to SQLite
      await ContactDatabase.upsertContacts(deduped);

      // Remove server-side deleted contacts
      if (parsed.changes?.removed?.length > 0) {
        await ContactDatabase.removeContacts(parsed.changes.removed);
      }

      // Remove stale contacts no longer on device / SIM
      const currentDeviceHashes = new Set(hashed.map((c) => c.hash).filter(Boolean));
      if (currentDeviceHashes.size > 0) {
        await ContactDatabase.removeStaleContacts(currentDeviceHashes).catch((err) =>
          console.warn('[useContactSync] removeStaleContacts error:', err?.message)
        );
      }

      // Save sync metadata
      const refreshedAt = clampNumber(parsed.refreshedAt, Date.now());
      const expiresMs = parseExpiresInToMs(parsed.expiresIn);
      await ContactDatabase.setSyncSessionId(parsed.syncSessionId);
      await ContactDatabase.setLastSyncTime(refreshedAt);
      await ContactDatabase.setSyncMetadata({
        syncSessionId: parsed.syncSessionId,
        syncedAt: refreshedAt,
        expiresIn: parsed.expiresIn,
        expiresAt: expiresMs > 0 ? refreshedAt + expiresMs : null,
        lastFullSync: refreshedAt,
        lastSyncStatus: `full_sync_${reason}`,
      });
      await ContactDatabase.markInitialSyncDone();

      setChanges(parsed.changes || { added: [], updated: [], removed: [], statusChanged: [] });
      await AsyncStorage.removeItem(STORAGE_KEYS.PENDING_REFRESH);

      // Reload UI from SQLite
      await applyFromDB();
    } catch (err) {
      if (mountedRef.current) setError(err?.message || 'Failed to sync contacts');
      throw err;
    } finally {
      if (mountedRef.current) {
        setIsSyncing(false);
        setIsExpiredUpdating(false);
      }
    }
  }, [socket, getHashedContacts, getClientInfo, withRetry, emitWithAckAndEvent, parseSyncResponse, normalizeIncomingContacts, applyFromDB]);

  // ─── INCREMENTAL REFRESH ───

  const runRefresh = useCallback(async ({
    reason = 'manual', silent = false, fallbackToSync = false, incremental = true
  } = {}) => {
    if (!socket?.emit) throw new Error('Socket not available for refresh');

    const sessionId = await ContactDatabase.getSyncSessionId();
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
        syncOptions: { incremental, includeStats: true, includeProfileImages: true }
      };

      const rawResponse = await withRetry(
        () => emitWithAckAndEvent('contact:refresh', payload, 'contact:refresh:response'),
        3
      );

      const parsed = parseSyncResponse(rawResponse);
      const normalizedIncoming = normalizeIncomingContacts(parsed.contacts);
      const deduped = dedupeByHashOrId(normalizedIncoming);

      // Upsert new/updated contacts into SQLite
      if (deduped.length > 0) {
        const now = Date.now();
        const enriched = deduped.map(c => ({
          ...c,
          isNewUntil: c.isNewUntil || now + UPDATE_HIGHLIGHT_MS,
          updatedHighlightUntil: now + UPDATE_HIGHLIGHT_MS,
        }));
        await ContactDatabase.upsertContacts(enriched);
      }

      // Remove deleted contacts
      if (parsed.changes?.removed?.length > 0) {
        await ContactDatabase.removeContacts(parsed.changes.removed);
      }

      // Update metadata
      const refreshedAt = clampNumber(parsed.refreshedAt, Date.now());
      const expiresMs = parseExpiresInToMs(parsed.expiresIn);
      const prevMeta = await ContactDatabase.getSyncMetadata() || {};
      await ContactDatabase.setSyncMetadata({
        ...prevMeta,
        syncSessionId: parsed.syncSessionId || sessionId,
        syncedAt: refreshedAt,
        expiresIn: parsed.expiresIn || prevMeta.expiresIn,
        expiresAt: expiresMs > 0 ? refreshedAt + expiresMs : prevMeta.expiresAt,
        lastRefreshedAt: refreshedAt,
        lastSyncStatus: `refresh_${reason}`,
      });
      await ContactDatabase.setLastSyncTime(refreshedAt);

      setChanges(parsed.changes || { added: [], updated: [], removed: [], statusChanged: [] });
      await AsyncStorage.removeItem(STORAGE_KEYS.PENDING_REFRESH);

      // Reload UI from SQLite
      await applyFromDB();
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      const invalidSession = msg.includes('session') || msg.includes('401') || msg.includes('unauthorized');
      if (invalidSession && fallbackToSync) {
        return runFullSync({ reason: 'invalid_session', silent });
      }
      if (mountedRef.current) setError(err?.message || 'Failed to refresh contacts');
      throw err;
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false);
        setIsBackgroundRefreshing(false);
      }
    }
  }, [socket, getDeviceId, withRetry, emitWithAckAndEvent, parseSyncResponse, normalizeIncomingContacts, applyFromDB, runFullSync]);

  // ─── MAIN ENTRY: syncContacts (called on screen open) ───

  const syncContacts = useCallback(async ({ reason = 'screen_open' } = {}) => {
    if (screenOpenSyncInProgressRef.current) return;
    screenOpenSyncInProgressRef.current = true;

    try {
      // Step 1: Load from SQLite immediately (instant UI)
      const cached = await applyFromDB();
      const hasCached = cached.length > 0;
      const initialDone = await ContactDatabase.isInitialSyncDone();

      if (!isConnected) {
        if (!hasCached) throw new Error('Offline and no cached contacts available');
        await AsyncStorage.setItem(STORAGE_KEYS.PENDING_REFRESH, 'true');
        return;
      }

      // Step 2: First time ever → full sync
      if (!initialDone) {
        await runFullSync({ reason: `${reason}_first_time`, silent: false });
        return;
      }

      // Step 3: Check if metadata expired
      const metadata = await ContactDatabase.getSyncMetadata();
      const isExpired = metadata?.expiresAt ? Date.now() >= Number(metadata.expiresAt) : false;

      if (isExpired) {
        if (mountedRef.current) setIsExpiredUpdating(true);
        await runFullSync({ reason: `${reason}_expired`, silent: false });
        return;
      }

      // Step 4: Has cached + not expired → silent background refresh for delta
      runRefresh({ reason: `${reason}_silent`, silent: true, fallbackToSync: true, incremental: true })
        .catch((err) => console.warn('[useContactSync] silent refresh failed:', err?.message));
    } finally {
      screenOpenSyncInProgressRef.current = false;
      if (mountedRef.current) setIsInitialLoading(false);
    }
  }, [applyFromDB, isConnected, runFullSync, runRefresh]);

  // ─── PUBLIC: refreshContacts (pull-to-refresh) ───
  // Always does a FULL sync so new device contacts (added since last sync) are discovered.
  // The incremental runRefresh only handles server-side changes — it never sends device
  // contact hashes, so new phone numbers would never appear.

  const refreshContacts = useCallback(async ({ fallbackToSync = true } = {}) => {
    if (!isConnected) {
      await AsyncStorage.setItem(STORAGE_KEYS.PENDING_REFRESH, 'true');
      throw new Error('Offline - refresh queued');
    }

    // Re-read device contacts fresh (picks up any newly added numbers)
    try { await askPermissionAndLoadContacts?.(); } catch {}

    // Always full sync: hashes ALL device contacts and sends to server.
    // Server returns the complete matched list including any new contacts.
    return runFullSync({ reason: 'pull_to_refresh', silent: false });
  }, [isConnected, runFullSync, askPermissionAndLoadContacts]);

  // ─── PUBLIC: processContacts ───

  const processContacts = useCallback(async () => {
    setIsProcessing(true);
    try { return await runFullSync({ reason: 'process_contacts', silent: false }); }
    finally { if (mountedRef.current) setIsProcessing(false); }
  }, [runFullSync]);

  // ─── PUBLIC: loadContacts (from SQLite only) ───

  const loadContacts = useCallback(async () => {
    return applyFromDB();
  }, [applyFromDB]);

  // ─── DISCOVER + INVITE (unchanged logic) ───

  const discoverContact = useCallback((contactHash) => {
    if (!socket?.emit || !contactHash) return Promise.reject(new Error('Invalid contact hash'));
    if (mountedRef.current) setIsSyncing(true);
    setDiscoverResponse(null);

    return new Promise((resolve, reject) => {
      let settled = false;
      const responseEvents = ['contact:discover:response', 'contactdiscover:response'];
      const cleanupListeners = () => responseEvents.forEach(e => socket?.off?.(e, handleResponse));

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
        if (mountedRef.current) { setDiscoverResponse(payload); setIsSyncing(false); }
        resolve(payload);
      };

      responseEvents.forEach(e => socket?.once?.(e, handleResponse));
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
    if (!socket?.emit) return Promise.reject(new Error('Socket not available'));
    if (mountedRef.current) setError(null);

    return new Promise((resolve, reject) => {
      socket.emit('contact:invite', payload, (ack) => {
        if (ack?.error || ack?.status === false) {
          const err = new Error(ack?.error || ack?.message || 'Failed to send invitation');
          setError(err.message);
          reject(err);
          return;
        }
        if (mountedRef.current) setInviteResponse(ack || { status: true, message: 'Invitation sent' });
        resolve(ack || { status: true });
      });
    });
  }, [socket]);

  // ─── BOOTSTRAP: load from SQLite on mount ───

  useEffect(() => {
    const bootstrap = async () => {
      if (bootstrappedRef.current) return;
      bootstrappedRef.current = true;
      await applyFromDB();
      if (mountedRef.current) setIsInitialLoading(false);
    };
    bootstrap();
  }, [applyFromDB]);

  // ─── RECONNECT: flush pending refresh ───

  useEffect(() => {
    if (!isConnected) return;
    const reconcile = async () => {
      const pending = await AsyncStorage.getItem(STORAGE_KEYS.PENDING_REFRESH);
      if (pending === 'true') {
        try { await refreshContacts({ fallbackToSync: true }); }
        catch (err) { console.warn('[useContactSync] pending refresh failed:', err?.message); }
      }
    };
    reconcile();
  }, [isConnected, refreshContacts]);

  // ─── SOCKET ERROR LISTENERS ───

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

  // ─── CLEAR HELPERS ───

  const clearDiscoverResponse = useCallback(() => {
    if (mountedRef.current) setDiscoverResponse(null);
  }, []);

  const clearInviteResponse = useCallback(() => {
    if (mountedRef.current) setInviteResponse(null);
  }, []);

  return {
    matchedContacts,
    matchedRegistered,
    matchedUnregistered,
    hashedContacts,
    isInitialLoading,
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
    hasCachedContacts: matchedContacts.length > 0,
    isCacheExpired: syncMetadata?.expiresAt ? Date.now() >= Number(syncMetadata.expiresAt) : false,
  };
};

export default useContactSync;