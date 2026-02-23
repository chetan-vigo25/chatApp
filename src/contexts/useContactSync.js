import { useState, useEffect, useCallback, useRef } from 'react';
import { useContacts } from './ContactContext';
import { getSocket, getSessionId } from '../Redux/Services/Socket/socket';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useDeviceInfo } from './DeviceInfoContext';
import contactHasher from '../Redux/Services/Contact/ContactHasher';

const STORAGE_KEYS = {
  MATCHED_CONTACTS: '@matched_contacts',
  LAST_SYNC: '@last_contact_sync',
  HASHED_CONTACTS: '@hashed_contacts',
  DEVICE_ID: '@device_id',
  LAST_SYNC_SESSION: '@last_sync_session',
  INITIAL_SYNC_DONE: '@initial_sync_done'
};

export const useContactSync = () => {
  const { contacts = [], askPermissionAndLoadContacts } = useContacts();
  const socket = getSocket();
  const deviceInfo = useDeviceInfo?.() || {};
  const sessionId = getSessionId?.();

  const mountedRef = useRef(true);
  const initialSyncTriggeredRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const [matchedContacts, setMatchedContacts] = useState([]);
  const [matchedRegistered, setMatchedRegistered] = useState([]);
  const [matchedUnregistered, setMatchedUnregistered] = useState([]);
  const [hashedContacts, setHashedContacts] = useState([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [lastSyncTime, setLastSyncTime] = useState(null);
  const [deviceId, setDeviceId] = useState(null);
  const [discoverResponse, setDiscoverResponse] = useState(null);
  const [inviteResponse, setInviteResponse] = useState(null);
  const [lastSyncSessionId, setLastSyncSessionId] = useState(null);

  /* ================= HELPERS ================= */
  const getDeviceId = useCallback(async () => {
    try {
      const id = await AsyncStorage.getItem(STORAGE_KEYS.DEVICE_ID);
      if (mountedRef.current) setDeviceId(id);
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
      appVersion: deviceInfo.appVersion || 'unknown_version',
      os: deviceInfo.osName || 'unknown_os',
      osVersion: deviceInfo.version || 'unknown_os_version',
      deviceModel: deviceInfo.modelName || 'unknown_model',
    };
  }, [deviceInfo, getDeviceId]);

  /* ================= HANDLERS ================= */
  const handleContactsMatchedCallback = useCallback(async (payload) => {
    try {
      const contactsArr =
        payload?.matches ||
        payload?.contacts ||
        payload?.data?.contacts ||
        [];

      if (!Array.isArray(contactsArr)) {
        console.warn('useContactSync: contacts payload not array', contactsArr);
        if (mountedRef.current) setIsSyncing(false);
        return;
      }

      // Build local hash map
      const localHashMap = {};
      for (const lc of (contacts || [])) {
        try {
          const phoneNumber = lc.phoneNumbers?.[0]?.number || lc.phoneNumber || null;
          if (!phoneNumber) continue;
          const hashedLocal = contactHasher.hashPhoneNumber(String(phoneNumber));
          if (hashedLocal?.hash) {
            localHashMap[hashedLocal.hash] = {
              originalPhone: phoneNumber,
              normalized: hashedLocal.normalized
            };
          }
        } catch {}
      }

      const normalized = contactsArr.map(c => {
        const serverName = c.name || c.fullName || c.displayName || c.username || c.contactName || '';
        const serverFullName = c.fullName || c.name || c.displayName || c.contactName || '';

        return {
          id: c.userId || c.originalId || c.id || c.hash || null,
          type: (c.type || 'unregistered').toLowerCase(),
          userId: c.userId || null,
          name: serverName,
          fullName: serverFullName,
          profilePicture: c.profilePicture || c.profileImage || c.avatar || '',
          about: c.about || '',
          isActive: !!c.isActive,
          canMessage: !!c.canMessage,
          isBlocked: !!c.isBlocked,
          lastLogin: c.lastLogin || null,
          hash: c.hash || null,
          originalId: c.originalId || null,
          algorithm: c.hashDetails?.algorithm || c.algorithm || null,
          salt: c.hashDetails?.salt || c.salt || null,
          originalPhone: c.originalPhone || c.phone || c.number || (c.hash ? (localHashMap[c.hash]?.originalPhone || null) : null),
          normalizedPhone: c.normalized || (c.hash ? (localHashMap[c.hash]?.normalized || null) : null),
          raw: c
        };
      });

      const registered = normalized.filter(c => c.type === 'registered' || !!c.userId);
      const unregistered = normalized.filter(c => c.type !== 'registered' && !c.userId);
      const combined = [...registered, ...unregistered];

      if (mountedRef.current) {
        setMatchedContacts(combined);
        setMatchedRegistered(registered);
        setMatchedUnregistered(unregistered);
        await AsyncStorage.setItem(STORAGE_KEYS.MATCHED_CONTACTS, JSON.stringify(combined));
        await AsyncStorage.setItem(STORAGE_KEYS.INITIAL_SYNC_DONE, 'true');

        const syncedAtValue = payload?.data?.syncedAt ?? payload?.timestamp ?? Date.now();
        const syncedAtDate = new Date(Number(syncedAtValue));
        setLastSyncTime(syncedAtDate);
        await AsyncStorage.setItem(STORAGE_KEYS.LAST_SYNC, syncedAtDate.toISOString());

        const syncSessionId = payload?.data?.syncSessionId ?? payload?.syncSessionId ?? null;
        if (syncSessionId) {
          setLastSyncSessionId(syncSessionId);
          await AsyncStorage.setItem(STORAGE_KEYS.LAST_SYNC_SESSION, syncSessionId);
        }

        setIsSyncing(false);
        setError(null);
      }

      console.log('useContactSync: matched contacts processed. registered:', registered.length, 'unregistered:', unregistered.length);
    } catch (err) {
      console.error('useContactSync: handleContactsMatchedCallback error:', err);
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [contacts]);

  const handleDiscoverResponseCallback = useCallback((payload) => {
    try {
      console.log('useContactSync: contactdiscover:response ->', JSON.stringify(payload, null, 2));
      if (mountedRef.current) setDiscoverResponse(payload);
    } catch (err) {
      console.error('useContactSync: handleDiscoverResponseCallback error:', err);
    }
  }, []);

  const handleInviteResponseCallback = useCallback((payload) => {
    try {
      console.log('useContactSync: invitesent:response ->', JSON.stringify(payload, null, 2));
      if (mountedRef.current) setInviteResponse(payload);
    } catch (err) {
      console.error('useContactSync: handleInviteResponseCallback error:', err);
    }
  }, []);

  const handleSyncErrorCallback = useCallback((data) => {
    console.error('useContactSync: contact sync error ->', data);
    if (mountedRef.current) {
      setError(data?.message || data || 'Sync failed');
      setIsSyncing(false);
    }
  }, []);

  const handleSyncSuccessCallback = useCallback((data) => {
    console.log('useContactSync: contact sync success ->', data);
    if (mountedRef.current) setIsSyncing(false);
  }, []);

  /* ================= LOAD CACHED DATA ================= */
  useEffect(() => {
    const loadCachedData = async () => {
      try {
        const [cachedMatched, cachedLastSync, cachedHashed, cachedSyncSession] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.MATCHED_CONTACTS),
          AsyncStorage.getItem(STORAGE_KEYS.LAST_SYNC),
          AsyncStorage.getItem(STORAGE_KEYS.HASHED_CONTACTS),
          AsyncStorage.getItem(STORAGE_KEYS.LAST_SYNC_SESSION)
        ]);

        if (cachedMatched) {
          const parsed = JSON.parse(cachedMatched);
          if (mountedRef.current) setMatchedContacts(parsed);

          const registered = parsed.filter(c => c.type === 'registered');
          const unregistered = parsed.filter(c => c.type !== 'registered');

          if (mountedRef.current) {
            setMatchedRegistered(registered);
            setMatchedUnregistered(unregistered);
          }
        }

        if (cachedLastSync && mountedRef.current) setLastSyncTime(new Date(cachedLastSync));
        if (cachedHashed && mountedRef.current) setHashedContacts(JSON.parse(cachedHashed));
        if (cachedSyncSession && mountedRef.current) setLastSyncSessionId(cachedSyncSession);
      } catch (err) {
        console.error('useContactSync: loadCachedData error:', err);
      }
    };

    loadCachedData();
  }, []);

  /* ================= INITIAL SYNC TRIGGER ================= */
  useEffect(() => {
    const triggerInitialSync = async () => {
      const initialSyncDone = await AsyncStorage.getItem(STORAGE_KEYS.INITIAL_SYNC_DONE);
      const hasLocalContacts = contacts && contacts.length > 0;
      const hasMatchedContacts = matchedContacts && matchedContacts.length > 0;

      if (initialSyncTriggeredRef.current || 
          (initialSyncDone && hasMatchedContacts) || 
          !hasLocalContacts || 
          isSyncing) {
        return;
      }

      initialSyncTriggeredRef.current = true;

      setTimeout(() => {
        if (mountedRef.current) {
          console.log('useContactSync: Triggering initial contact sync');
          syncContactsToServer();
        }
      }, 1000);
    };

    triggerInitialSync();
  }, [contacts, matchedContacts, isSyncing]);

  /* ================= SOCKET LISTENERS ================= */
  useEffect(() => {
    if (!socket?.on) return;

    socket.on('contact:sync:response', handleContactsMatchedCallback);
    socket.on('contact:sync:error', handleSyncErrorCallback);
    socket.on('contact:sync:success', handleSyncSuccessCallback);
    socket.on('contactdiscover:response', handleDiscoverResponseCallback);
    socket.on('invitesent:response', handleInviteResponseCallback);

    return () => {
      if (!socket?.off) return;
      socket.off('contact:sync:response', handleContactsMatchedCallback);
      socket.off('contact:sync:error', handleSyncErrorCallback);
      socket.off('contact:sync:success', handleSyncSuccessCallback);
      socket.off('contactdiscover:response', handleDiscoverResponseCallback);
      socket.off('invitesent:response', handleInviteResponseCallback);
    };
  }, [
    socket,
    handleContactsMatchedCallback,
    handleSyncErrorCallback,
    handleSyncSuccessCallback,
    handleDiscoverResponseCallback,
    handleInviteResponseCallback
  ]);

  /* ================= PROCESS CONTACTS ================= */
  const processContacts = useCallback(async () => {
    try {
      setIsProcessing(true);
      setError(null);

      const hashed = contactHasher.hashContactList(contacts || []);
      const valid = hashed.filter(contact => contactHasher.validateHashedContact(contact));

      if (mountedRef.current) setHashedContacts(valid);
      await AsyncStorage.setItem(STORAGE_KEYS.HASHED_CONTACTS, JSON.stringify(valid));

      await syncContactsToServer(valid);
    } catch (err) {
      console.error('useContactSync: processContacts error:', err);
      if (mountedRef.current) setError(err?.message || 'Failed to process contacts');
    } finally {
      if (mountedRef.current) setIsProcessing(false);
    }
  }, [contacts]);

  /* ================= CONTACT SYNC ================= */
  const syncContactsToServer = useCallback(async (contactsToSync = null) => {
    if (!socket?.emit) {
      const err = 'Socket not available for syncContactsToServer';
      console.warn(err);
      setError(err);
      return;
    }

    if (mountedRef.current) {
      setIsSyncing(true);
      setError(null);
    }

    try {
      const toSync = contactsToSync || hashedContacts || [];
      if (toSync.length === 0) {
        console.log('useContactSync: No contacts to sync');
        if (mountedRef.current) setIsSyncing(false);
        return;
      }

      const hashedContactsData = toSync.map(contact => ({
        id: contact.id,
        fullName: contact.fullName || contact.name || '',
        hash: contact.hash,
        salt: contact.salt,
        algorithm: contact.algorithm,
        encryptNumber: contact.encryptNumber || (contact.normalizedPhone && contact.salt ? contactHasher.encryptContent(contact.normalizedPhone + contact.salt) : null)
      }));

      const clientInfo = await getClientInfo();

      const payload = {
        contacts: hashedContactsData,
        clientInfo,
        syncOptions: { fullSync: true, overwrite: false },
        syncSessionId: lastSyncSessionId
      };

      socket.emit('contact:sync', payload, (ack) => {
        if (ack?.error && mountedRef.current) setError(ack.error);
      });
    } catch (err) {
      console.error('useContactSync: syncContactsToServer error:', err);
      if (mountedRef.current) setError(err?.message || 'Failed to sync contacts');
    } finally {
      if (mountedRef.current) setIsSyncing(false);
    }
  }, [socket, hashedContacts, getClientInfo, lastSyncSessionId]);

  /* ================= DISCOVER CONTACT ================= */
  const discoverContact = useCallback((contactHash) => {
    if (!socket?.emit || !contactHash) return;

    if (mountedRef.current) setIsSyncing(true);
    clearDiscoverResponse();

    return new Promise((resolve, reject) => {
      const handleResponse = (payload) => {
        try { socket.off('contactdiscover:response', handleResponse); } catch {}
        if (mountedRef.current) {
          setDiscoverResponse(payload);
          setIsSyncing(false);
        }
        resolve(payload);
      };

      socket.on('contactdiscover:response', handleResponse);
      socket.emit('contact:discover', { contactHash }, (ack) => {
        if (ack?.error) {
          try { socket.off('contactdiscover:response', handleResponse); } catch {}
          if (mountedRef.current) setIsSyncing(false);
          setError(ack.error);
          reject(new Error(ack.error));
        }
      });

      setTimeout(() => {
        try { socket.off('contactdiscover:response', handleResponse); } catch {}
        if (mountedRef.current) setIsSyncing(false);
        reject(new Error('discoverContact: timeout'));
      }, 30000);
    });
  }, [socket]);

  /* ================= CLEAR RESPONSE ================= */
  const clearDiscoverResponse = useCallback(() => { if (mountedRef.current) setDiscoverResponse(null); }, []);
  const clearInviteResponse = useCallback(() => { if (mountedRef.current) setInviteResponse(null); }, []);

  /* ================= RETURN ================= */
  return {
    matchedContacts,
    matchedRegistered,
    matchedUnregistered,
    hashedContacts,
    isProcessing,
    isSyncing,
    error,
    lastSyncTime,
    discoverResponse,
    inviteResponse,
    totalContacts: contacts.length,
    matchedCount: matchedContacts.length,
    discoverContact,
    clearDiscoverResponse,
    clearInviteResponse,
    syncContacts: processContacts,
    processContacts,
    lastSyncSessionId
  };
};

export default useContactSync;