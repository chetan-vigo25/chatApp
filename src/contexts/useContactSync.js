import { useState, useEffect, useCallback, useRef } from 'react';
import * as Contacts from 'expo-contacts';
import { useContacts } from './ContactContext';
import { useNetwork } from './NetworkContext';
import { getSocket } from '../Redux/Services/Socket/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDeviceInfo } from './DeviceInfoContext';
import contactHasher from '../Redux/Services/Contact/ContactHasher';
import ContactDatabase from '../services/ContactDatabase';
import { suspendAppLock, resumeAppLock } from '../services/appLockGuard';

const STORAGE_KEYS = {
  DEVICE_ID: '@device_id',
  PENDING_REFRESH: '@pending_contact_refresh',
  // Persistent raw-phone → E.164 cache so a resync only runs libphonenumber-js on
  // numbers it hasn't seen before (the main cost on a large phonebook).
  E164_CACHE: '@contact_e164_cache',
};

const UPDATE_HIGHLIGHT_MS = 24 * 60 * 60 * 1000;

// Contacts synced per socket frame. Devices with thousands of contacts can't be
// sent in one payload (huge frame + a server-side validation/match loop that
// blocks the event loop + one giant Mongo write). Lists larger than this are
// streamed in batches sharing one batch id; the server matches + accumulates
// each and finalizes on the last. Must stay <= the server's per-batch cap
// (MAX_CONTACTS_PER_BATCH = 1000 in contect.handler.js).
const SYNC_BATCH_SIZE = 800;

// The FIRST chunk of a large first-sync is deliberately small so the earliest
// matched contacts render almost immediately (the whole point of progressive
// reveal) instead of the user staring at a spinner while an 800-contact batch is
// matched server-side. Later chunks use the full SYNC_BATCH_SIZE for throughput.
const FIRST_SYNC_BATCH_SIZE = 200;

// First-time sync preview: parse + send ONLY this many device contacts up front so
// the first screenful lands in ~1-2s, THEN the full phonebook syncs in the
// background. Kept small because normalizing the WHOLE phonebook to E.164
// (libphonenumber-js) is the dominant client-side cost on a large first sync —
// parsing just the head lets the list appear before that finishes.
const PREVIEW_SYNC_SIZE = 100;

// First screen paint from SQLite: bridge only this many rows out of the native DB
// before rendering, so the contacts screen appears well under a second even on a
// multi-thousand-row phonebook. The full table streams in right after.
const FIRST_PAINT_LIMIT = 100;

// Build ramped chunks: one small head chunk (firstSize) for instant first paint,
// then rest-sized chunks. Keeps total round-trips low while making the list
// appear fast. e.g. 2000 items → [200, 800, 800, 200].
const buildRampedChunks = (items, firstSize, restSize) => {
  const chunks = [];
  if (!items.length) return chunks;
  chunks.push(items.slice(0, firstSize));
  for (let i = firstSize; i < items.length; i += restSize) {
    chunks.push(items.slice(i, i + restSize));
  }
  return chunks;
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

const dedupeByNumberOrId = (contacts = []) => {
  const seen = new Set();
  const list = [];
  for (const contact of contacts) {
    const key = contact?.phoneNumber || contact?.normalizedPhone || contact?.userId || contact?.originalId;
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
  // Guards the background full sync so a screen re-open (while the first-time full
  // sync is still streaming in the background) doesn't spawn a duplicate one.
  const fullSyncInProgressRef = useRef(false);

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

  // Ref to hold the latest fresh device contacts (updated by getE164Contacts)
  const freshDeviceContactsRef = useRef([]);

  // Map of E.164 number -> device-saved details, so incoming server matches can be
  // labelled with the name as saved on THIS device (WhatsApp behaviour).
  const buildLocalNumberMap = useCallback(() => {
    const contacts = freshDeviceContactsRef.current.length > 0
      ? freshDeviceContactsRef.current
      : (deviceContacts || []);
    const map = {};
    for (const localContact of contacts) {
      const nums = (localContact?.phoneNumbers || []).map(p => p?.number).filter(Boolean);
      if (localContact?.phoneNumber) nums.push(localContact.phoneNumber);
      for (const raw of nums) {
        const e164 = contactHasher.toE164(String(raw));
        if (!e164 || map[e164]) continue;
        map[e164] = {
          originalId: localContact?.id || null,
          originalPhone: raw,
          localName: localContact?.name || null
        };
      }
    }
    return map;
  }, [deviceContacts]);

  const normalizeIncomingContacts = useCallback((incoming = []) => {
    const numberMap = buildLocalNumberMap();
    return incoming.filter(Boolean).map((contact) => {
      const phoneNumber = contact?.phoneNumber || contact?.normalizedPhone || null;
      const localMapEntry = phoneNumber ? numberMap[phoneNumber] : null;
      // Device contact name takes priority over the backend-stored name, per
      // product spec (show the name as saved on THIS device). Fall back to the
      // backend name only when the number isn't in the device's contacts.
      const fullName = localMapEntry?.localName || contact?.fullName || contact?.name || contact?.displayName || '';
      return {
        originalId: contact?.originalId || localMapEntry?.originalId || contact?.id || null,
        phoneNumber,
        type: (contact?.type || (contact?.userId ? 'registered' : 'unregistered')).toLowerCase(),
        userId: contact?.userId || null,
        fullName,
        name: fullName,
        email: contact?.email || null,
        mobile: contact?.mobile || {
          code: null,
          number: contact?.phone || contact?.number || localMapEntry?.originalPhone || phoneNumber || null
        },
        mobileFormatted: contact?.mobileFormatted || contact?.phone || contact?.number || localMapEntry?.originalPhone || phoneNumber || '',
        profileImage: contact?.profileImage || contact?.profilePicture || contact?.avatar || '',
        profilePicture: contact?.profileImage || contact?.profilePicture || contact?.avatar || '',
        about: contact?.about || '',
        isActive: !!contact?.isActive,
        lastLogin: contact?.lastLogin || null,
        canMessage: contact?.canMessage ?? !!contact?.userId,
        isBlocked: !!contact?.isBlocked,
        isVerified: !!contact?.isVerified,
        isFavorite: !!contact?.isFavorite,
        lastContacted: contact?.lastContacted || null,
        isNewUntil: contact?.isNewUntil || null,
        updatedHighlightUntil: contact?.updatedHighlightUntil || null,
        joinedWhatsAppAt: contact?.joinedWhatsAppAt || null,
        originalPhone: contact?.originalPhone || localMapEntry?.originalPhone || phoneNumber || null,
        normalizedPhone: phoneNumber,
      };
    });
  }, [buildLocalNumberMap]);

  // ─── APPLY TO STATE FROM SQLITE ───

  // First-paint guards: the head page is loaded exactly once per hook lifetime,
  // and never applied after a full-table load has already landed (a late head
  // page must not shrink an already-complete list back down to 100 rows).
  const firstPaintDoneRef = useRef(false);
  const fullAppliedRef = useRef(false);

  const applyContactsToState = useCallback((all) => {
    if (!mountedRef.current) return;
    setMatchedContacts(all);
    setMatchedRegistered(all.filter(c => c.type === 'registered' || !!c.userId));
    setMatchedUnregistered(all.filter(c => c.type !== 'registered' && !c.userId));
  }, []);

  const applyFromDB = useCallback(async () => {
    try {
      // Phase 1 (first call only): paint the head of the table immediately —
      // bridging 100 rows is fast no matter how big the phonebook is — and drop
      // the initial spinner so the user sees contacts right away. The full load
      // below then replaces it.
      if (!firstPaintDoneRef.current) {
        firstPaintDoneRef.current = true;
        try {
          const head = await ContactDatabase.loadContactsPage(FIRST_PAINT_LIMIT, 0);
          if (head.length > 0 && !fullAppliedRef.current) {
            applyContactsToState(head);
            if (mountedRef.current) setIsInitialLoading(false);
          }
        } catch (headErr) {
          console.warn('[useContactSync] first-paint load error:', headErr?.message);
        }
      }

      // Phase 2: full table.
      const all = await ContactDatabase.loadAllContacts();
      fullAppliedRef.current = true;
      applyContactsToState(all);

      const [sessionId, lastSync, metadata] = await Promise.all([
        ContactDatabase.getSyncSessionId(),
        ContactDatabase.getLastSyncTime(),
        ContactDatabase.getSyncMetadata(),
      ]);

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
  }, [applyContactsToState]);

  // ─── HASHING ───

  /**
   * Read contacts FRESH from device every time. Don't rely on the stale
   * deviceContacts closure — it won't reflect numbers added after mount.
   */
  const readFreshDeviceContacts = useCallback(async () => {
    // The permission dialog can background the app (OEM-dependent) — suspend
    // the app lock so a contact fetch never bounces to the lock screen.
    suspendAppLock();
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') return [];
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });
      const filtered = (data || []).filter(c => c.phoneNumbers?.length > 0);
      freshDeviceContactsRef.current = filtered; // save for buildLocalNumberMap
      return filtered;
    } catch (err) {
      console.warn('[useContactSync] readFreshDeviceContacts error:', err?.message);
      return [];
    } finally {
      resumeAppLock();
    }
  }, []);

  /**
   * Read device contacts fresh and normalize every number to plaintext E.164
   * (libphonenumber-js), deduped across the whole phonebook. No hashing. A device
   * contact may carry several numbers — each becomes its own entry.
   * Returns [{ id, fullName, phoneNumber, originalPhone }].
   */
  const getE164Contacts = useCallback(async () => {
    const freshContacts = await readFreshDeviceContacts();
    if (freshContacts.length === 0) return [];

    // Persistent raw-phone → E.164 cache. libphonenumber-js parsing is the dominant
    // cost of a resync (thousands of numbers), and a number that hasn't changed
    // normalizes to the same E.164 forever — so we only pay the parse cost for NEW
    // raw numbers. Null results are cached too, so junk isn't re-parsed every time.
    let cache = {};
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.E164_CACHE);
      if (raw) cache = JSON.parse(raw) || {};
    } catch { cache = {}; }

    const nextCache = {};
    let cacheMisses = 0;
    const seen = new Set();
    const valid = [];

    for (const contact of freshContacts) {
      const rawNumbers = (contact.phoneNumbers || []).map(p => p?.number).filter(Boolean);
      if (contact.phoneNumber) rawNumbers.push(contact.phoneNumber);

      for (const rawPhone of rawNumbers) {
        const key = String(rawPhone);
        let e164 = Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : undefined;
        if (e164 === undefined) {
          e164 = contactHasher.toE164(key); // string or null; only new numbers hit this
          cacheMisses += 1;
        }
        // Keep only entries for numbers still on the device so the cache can't grow
        // unbounded across SIM/contact churn.
        nextCache[key] = e164;

        if (!e164 || seen.has(e164)) continue; // invalid or duplicate → skip
        seen.add(e164);
        valid.push({
          id: contact.id || e164,
          fullName: contact.name || '',
          phoneNumber: e164,
          originalPhone: rawPhone,
        });
      }
    }

    // Persist the pruned cache only when it actually changed.
    if (cacheMisses > 0 || Object.keys(nextCache).length !== Object.keys(cache).length) {
      AsyncStorage.setItem(STORAGE_KEYS.E164_CACHE, JSON.stringify(nextCache)).catch(() => {});
    }

    if (mountedRef.current) setHashedContacts(valid);
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

  const runFullSync = useCallback(async ({ reason = 'manual', silent = false, force = false } = {}) => {
    if (!socket?.emit) throw new Error('Socket not available for full sync');

    // A full sync is already running (e.g. the background one kicked off after the
    // preview) — don't start a second, overlapping full re-upload + re-match.
    if (fullSyncInProgressRef.current) return;
    fullSyncInProgressRef.current = true;

    const e164Contacts = await getE164Contacts();
    if (!e164Contacts.length) {
      await ContactDatabase.setSyncMetadata({ lastSyncStatus: 'empty_device_contacts' });
      await applyFromDB();
      fullSyncInProgressRef.current = false;
      return;
    }

    // ── Delta content-hash short-circuit ──
    // Hash the sorted E.164 set. If it matches the last successful sync's hash and
    // we've synced before, the phonebook is unchanged → send NO network request.
    const numbers = e164Contacts.map((c) => c.phoneNumber);
    const contactsHash = contactHasher.computeContactListHash(numbers);
    const prevHash = await ContactDatabase.getContactsHash();
    const initialDone = await ContactDatabase.isInitialSyncDone();
    if (!force && initialDone && prevHash && prevHash === contactsHash) {
      await applyFromDB();
      fullSyncInProgressRef.current = false;
      return;
    }

    if (mountedRef.current) {
      setError(null);
      if (!silent) setIsSyncing(true);
    }

    try {
      const clientInfo = await getClientInfo();

      // Plaintext E.164 payload — no hashing. `fullName` is the device-saved label
      // the backend persists; matching is by `phoneNumber`.
      const toPayloadItem = (contact) => ({
        id: contact.id,
        originalId: contact.id,
        fullName: contact.fullName || null,
        phoneNumber: contact.phoneNumber,
      });

      const allItems = e164Contacts.map(toPayloadItem);
      const syncOptions = { fullSync: true, overwrite: false };

      let parsed;
      if (allItems.length <= FIRST_SYNC_BATCH_SIZE) {
        // ── Single-shot (small phonebook, <= first-batch size) ──
        const rawResponse = await withRetry(
          () => emitWithAckAndEvent('contact:sync', { contacts: allItems, clientInfo, syncOptions }, 'contact:sync:response'),
          3
        );
        parsed = parseSyncResponse(rawResponse);
        const deduped = dedupeByNumberOrId(normalizeIncomingContacts(parsed.contacts));
        await ContactDatabase.upsertContacts(deduped);
        await applyFromDB(); // reflect immediately
      } else {
        // ── Batched streaming (large phonebook) — lazy/progressive ──
        // One shared batch id ties the chunks together server-side. Chunks are RAMPED:
        // a small 200-item head chunk lands + renders first (fast first paint), then
        // full-size chunks stream in. Chunks are sent SEQUENTIALLY because the server
        // finalizes on the last index and resets its accumulator on index 0, so order
        // must be preserved. Each chunk's matches are upserted AND rendered as they
        // land, so the list fills in gradually instead of blocking on the whole set.
        const batchId = `${clientInfo?.deviceId || 'dev'}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const chunks = buildRampedChunks(allItems, FIRST_SYNC_BATCH_SIZE, SYNC_BATCH_SIZE);
        const total = chunks.length;
        let lastParsed = null;

        for (let index = 0; index < total; index++) {
          const chunk = chunks[index];
          const payload = { contacts: chunk, clientInfo, syncOptions, batch: { id: batchId, index, total } };

          const rawResponse = await withRetry(
            () => emitWithAckAndEvent('contact:sync', payload, 'contact:sync:response'),
            3
          );

          const chunkParsed = parseSyncResponse(rawResponse);
          const chunkDeduped = dedupeByNumberOrId(normalizeIncomingContacts(chunkParsed.contacts));
          if (chunkDeduped.length) {
            await ContactDatabase.upsertContacts(chunkDeduped);
            // Progressive reveal, but don't reload the WHOLE table after every batch
            // (that's O(n) each time → O(n²) for a big first sync). Repaint on the
            // first batch (instant first contacts), then every 3rd, and at the end.
            if (index === 0 || index % 3 === 0 || index === total - 1) await applyFromDB();
          }

          if (index === total - 1) lastParsed = chunkParsed;
        }

        // Only the final (isLast) response carries syncSessionId/stats.
        parsed = lastParsed || parseSyncResponse(null);
      }

      // Remove server-side deleted contacts
      if (parsed.changes?.removed?.length > 0) {
        await ContactDatabase.removeContacts(parsed.changes.removed);
      }

      // Remove stale contacts no longer on device / SIM (keyed by E.164 number)
      const currentDeviceNumbers = new Set(numbers.filter(Boolean));
      if (currentDeviceNumbers.size > 0) {
        await ContactDatabase.removeStaleContacts(currentDeviceNumbers).catch((err) =>
          console.warn('[useContactSync] removeStaleContacts error:', err?.message)
        );
      }

      // Save sync metadata. Contacts are PERMANENT now — no expiry. Resync is
      // driven by the content hash changing, not by a TTL.
      const refreshedAt = clampNumber(parsed.refreshedAt, Date.now());
      await ContactDatabase.setSyncSessionId(parsed.syncSessionId);
      await ContactDatabase.setLastSyncTime(refreshedAt);
      await ContactDatabase.setContactsHash(contactsHash);
      await ContactDatabase.setSyncMetadata({
        syncSessionId: parsed.syncSessionId,
        syncedAt: refreshedAt,
        lastFullSync: refreshedAt,
        lastSyncStatus: `full_sync_${reason}`,
      });
      await ContactDatabase.markInitialSyncDone();

      setChanges(parsed.changes || { added: [], updated: [], removed: [], statusChanged: [] });
      await AsyncStorage.removeItem(STORAGE_KEYS.PENDING_REFRESH);

      // Final reload from SQLite
      await applyFromDB();
    } catch (err) {
      if (mountedRef.current) setError(err?.message || 'Failed to sync contacts');
      throw err;
    } finally {
      fullSyncInProgressRef.current = false;
      if (mountedRef.current) {
        setIsSyncing(false);
        setIsExpiredUpdating(false);
      }
    }
  }, [socket, getE164Contacts, getClientInfo, withRetry, emitWithAckAndEvent, parseSyncResponse, normalizeIncomingContacts, applyFromDB]);

  // ─── DELTA SYNC (only added / removed numbers) ───
  // After the first full sync, subsequent syncs send ONLY the numbers added since
  // last time (+ a removed list) — not the whole phonebook. Adding one contact
  // costs one small round-trip, not a full re-upload + re-match.
  const runDeltaSync = useCallback(async ({ reason = 'delta', silent = true } = {}) => {
    if (!socket?.emit) throw new Error('Socket not available for delta sync');

    const e164Contacts = await getE164Contacts();
    const numbers = e164Contacts.map((c) => c.phoneNumber);
    const contactsHash = contactHasher.computeContactListHash(numbers);

    // Nothing changed since last sync → ZERO network.
    const prevHash = await ContactDatabase.getContactsHash();
    if (prevHash && prevHash === contactsHash) {
      await applyFromDB();
      return;
    }

    // Diff the device set against what we already hold locally.
    const existing = await ContactDatabase.getExistingNumbers(); // Set<E.164>
    const deviceSet = new Set(numbers);
    const added = e164Contacts.filter((c) => !existing.has(c.phoneNumber));
    const removed = [...existing].filter((n) => !deviceSet.has(n));

    // No structural change (e.g. only a saved-name edit) → just record the hash.
    if (added.length === 0 && removed.length === 0) {
      await ContactDatabase.setContactsHash(contactsHash);
      await applyFromDB();
      return;
    }

    if (mountedRef.current) {
      setError(null);
      if (!silent) setIsSyncing(true);
    }

    try {
      const clientInfo = await getClientInfo();
      const toPayloadItem = (c) => ({ id: c.id, originalId: c.id, fullName: c.fullName || null, phoneNumber: c.phoneNumber });
      const addedItems = added.map(toPayloadItem);

      const applyResponse = async (parsed) => {
        const deduped = dedupeByNumberOrId(normalizeIncomingContacts(parsed.contacts));
        if (deduped.length) await ContactDatabase.upsertContacts(deduped);
      };

      if (addedItems.length <= SYNC_BATCH_SIZE) {
        // Single frame carries the added set, the removed list, and the full hash.
        const payload = {
          contacts: addedItems,
          removedContacts: removed,
          syncOptions: { incremental: true },
          contactsHash,
          clientInfo,
        };
        const rawResponse = await withRetry(
          () => emitWithAckAndEvent('contact:sync', payload, 'contact:sync:response'),
          3
        );
        await applyResponse(parseSyncResponse(rawResponse));
      } else {
        // Rare: a huge number of contacts added at once → stream the added set.
        const batchId = `${clientInfo?.deviceId || 'dev'}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
        const total = Math.ceil(addedItems.length / SYNC_BATCH_SIZE);
        for (let index = 0; index < total; index++) {
          const chunk = addedItems.slice(index * SYNC_BATCH_SIZE, (index + 1) * SYNC_BATCH_SIZE);
          const isLast = index === total - 1;
          const payload = {
            contacts: chunk,
            syncOptions: { incremental: true },
            batch: { id: batchId, index, total },
            // removed list + full hash only on the final frame.
            ...(isLast ? { removedContacts: removed, contactsHash } : {}),
            clientInfo,
          };
          const rawResponse = await withRetry(
            () => emitWithAckAndEvent('contact:sync', payload, 'contact:sync:response'),
            3
          );
          await applyResponse(parseSyncResponse(rawResponse));
        }
      }

      // Drop removed contacts locally.
      if (removed.length) await ContactDatabase.removeContacts(removed);

      // Record the new full-set hash + sync time.
      const now = Date.now();
      await ContactDatabase.setContactsHash(contactsHash);
      await ContactDatabase.setLastSyncTime(now);
      const prevMeta = (await ContactDatabase.getSyncMetadata()) || {};
      await ContactDatabase.setSyncMetadata({ ...prevMeta, syncedAt: now, lastSyncStatus: `delta_${reason}` });

      await applyFromDB();
    } catch (err) {
      if (mountedRef.current) setError(err?.message || 'Failed to sync contacts');
      throw err;
    } finally {
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [socket, getE164Contacts, getClientInfo, withRetry, emitWithAckAndEvent, parseSyncResponse, normalizeIncomingContacts, applyFromDB]);

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
      const deduped = dedupeByNumberOrId(normalizedIncoming);

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

  // ─── FAST FIRST-PAINT PREVIEW ───
  // Parse + send ONLY the first `limit` device contacts so the earliest matches
  // render in ~1-2s, instead of waiting for the WHOLE phonebook to be normalized to
  // E.164 (the dominant client cost on a large first sync). Uses an INCREMENTAL sync
  // so it MERGES (non-destructive) into the server's ContactSync — the authoritative
  // full sync runs right after in the background. Returns how many contacts it
  // rendered so the caller knows whether anything is on screen yet.
  const runPreviewSync = useCallback(async ({ limit = PREVIEW_SYNC_SIZE } = {}) => {
    if (!socket?.emit) return 0;

    const freshContacts = await readFreshDeviceContacts();
    if (!freshContacts.length) return 0;

    // Normalize just the head of the phonebook to E.164 (cheap — a few dozen parses).
    const seen = new Set();
    const items = [];
    for (const contact of freshContacts) {
      if (items.length >= limit) break;
      const rawNumbers = (contact.phoneNumbers || []).map(p => p?.number).filter(Boolean);
      if (contact.phoneNumber) rawNumbers.push(contact.phoneNumber);
      for (const rawPhone of rawNumbers) {
        const e164 = contactHasher.toE164(String(rawPhone));
        if (!e164 || seen.has(e164)) continue;
        seen.add(e164);
        items.push({ id: contact.id || e164, originalId: contact.id || e164, fullName: contact.name || null, phoneNumber: e164 });
        if (items.length >= limit) break;
      }
    }
    if (!items.length) return 0;

    const clientInfo = await getClientInfo();
    // Incremental so it merges (server does existing ∪ added) rather than replacing
    // the stored set with just these `limit`. No contactsHash sent → the client-side
    // delta short-circuit stays unset until the full sync records the real full hash.
    const rawResponse = await withRetry(
      () => emitWithAckAndEvent(
        'contact:sync',
        { contacts: items, clientInfo, syncOptions: { incremental: true } },
        'contact:sync:response'
      ),
      2
    );
    const parsed = parseSyncResponse(rawResponse);
    const deduped = dedupeByNumberOrId(normalizeIncomingContacts(parsed.contacts));
    if (deduped.length) {
      await ContactDatabase.upsertContacts(deduped);
      await applyFromDB();
    }
    return deduped.length;
  }, [socket, readFreshDeviceContacts, getClientInfo, withRetry, emitWithAckAndEvent, parseSyncResponse, normalizeIncomingContacts, applyFromDB]);

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

      // Step 2: First time ever → fast preview then background full sync.
      // Phase 1 (awaited): parse + send only the first PREVIEW_SYNC_SIZE contacts so
      // the list appears in ~1-2s. Phase 2 (background, NOT awaited): the full
      // phonebook syncs, finalizes, and marks initial-sync done. If the preview
      // showed nothing (failed / no matches yet), fall back to awaiting the full
      // sync so the user isn't left on an empty screen.
      if (!initialDone) {
        let previewCount = 0;
        try {
          previewCount = await runPreviewSync({ limit: PREVIEW_SYNC_SIZE });
        } catch (err) {
          console.warn('[useContactSync] preview sync failed:', err?.message);
        }

        const fullSyncPromise = runFullSync({ reason: `${reason}_first_time`, silent: previewCount > 0 })
          .catch((err) => console.warn('[useContactSync] background full sync failed:', err?.message));

        // Nothing on screen yet → wait for the full sync; otherwise let it run in
        // the background while the previewed contacts are already visible.
        if (previewCount === 0) await fullSyncPromise;
        return;
      }

      // Step 3: Already synced once → DELTA sync. Sends only numbers added/removed
      // since last time (zero network if nothing changed). Silent so an unchanged
      // open is invisible. Contacts are permanent — no TTL expiry.
      runDeltaSync({ reason, silent: true })
        .catch((err) => console.warn('[useContactSync] delta sync failed:', err?.message));
    } finally {
      screenOpenSyncInProgressRef.current = false;
      if (mountedRef.current) setIsInitialLoading(false);
    }
  }, [applyFromDB, isConnected, runFullSync, runDeltaSync, runPreviewSync]);

  // ─── PUBLIC: refreshContacts (pull-to-refresh) ───
  // Delta sync: re-reads the device phonebook and sends only what changed (added /
  // removed) — fast, not a full re-upload. First-ever run still falls back to a
  // full sync. Contacts that JOINED since last sync flip live via the
  // `contact:registered` push, so a manual refresh doesn't need a full re-match.

  const refreshContacts = useCallback(async ({ fallbackToSync = true } = {}) => {
    if (!isConnected) {
      await AsyncStorage.setItem(STORAGE_KEYS.PENDING_REFRESH, 'true');
      throw new Error('Offline - refresh queued');
    }

    // Re-read device contacts fresh (picks up any newly added numbers)
    try { await askPermissionAndLoadContacts?.(); } catch {}

    const initialDone = await ContactDatabase.isInitialSyncDone();
    if (!initialDone) return runFullSync({ reason: 'pull_to_refresh_first', silent: false });
    return runDeltaSync({ reason: 'pull_to_refresh', silent: false });
  }, [isConnected, runFullSync, runDeltaSync, askPermissionAndLoadContacts]);

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

  const discoverContact = useCallback((phoneNumber) => {
    if (!socket?.emit || !phoneNumber) return Promise.reject(new Error('Invalid phone number'));
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
      socket.emit('contact:discover', { phoneNumber }, (ack) => {
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

    // "X joined the app" — pushed by the backend when someone in our phonebook
    // registers. Upsert them as a registered contact so they flip live without a
    // resync, then refresh the UI from SQLite.
    const handleContactRegistered = async (payload) => {
      try {
        const data = payload?.data || payload;
        const phoneNumber = data?.phoneNumber || data?.normalizedPhone;
        if (!phoneNumber) return;
        const [normalized] = normalizeIncomingContacts([{
          ...data,
          phoneNumber,
          type: 'registered',
          userId: data?.userId || null,
        }]);
        if (normalized) {
          await ContactDatabase.upsertContacts([normalized]);
          await applyFromDB();
        }
      } catch (err) {
        console.warn('[useContactSync] contact:registered handler error:', err?.message);
      }
    };

    socket.on('contact:sync:error', handleSyncError);
    socket.on('invitesent:response', handleInviteResponse);
    socket.on('contact:registered', handleContactRegistered);

    return () => {
      socket?.off?.('contact:sync:error', handleSyncError);
      socket?.off?.('invitesent:response', handleInviteResponse);
      socket?.off?.('contact:registered', handleContactRegistered);
    };
  }, [socket, normalizeIncomingContacts, applyFromDB]);

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