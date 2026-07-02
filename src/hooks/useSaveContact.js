import { useState, useEffect, useCallback, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { getSocket } from '../Redux/Services/Socket/socket';
import {
  findInDeviceContacts,
  saveToDeviceContacts,
  upsertContactToSQLite,
} from '../services/SaveContactService';
import ContactDatabase from '../services/ContactDatabase';
import contactHasher from '../Redux/Services/Contact/ContactHasher';
import useContactSync from '../contexts/useContactSync';
import { chatListData } from '../Redux/Reducer/Chat/Chat.reducer';

const SYNC_DEBOUNCE_MS = 1500;

/**
 * Hook to manage the "Save Contact" flow for a peer user in a 1:1 chat.
 *
 * @param {object} peerUser - The peer user object from chatData.peerUser
 */
const useSaveContact = (peerUser) => {
  const [isUnknown, setIsUnknown] = useState(false);   // true = not in device contacts
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [savedSuccessfully, setSavedSuccessfully] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const syncDebounceRef = useRef(null);
  const checkDoneRef = useRef(false);
  const socket = getSocket();
  const dispatch = useDispatch();
  const { refreshContacts } = useContactSync();

  // ── Derive normalized phone from peer user ──────────────────────────────
  const getNormalizedPhone = useCallback(() => {
    if (!peerUser) return null;
    const raw =
      peerUser.mobileNumber ||
      peerUser.phoneNumber ||
      peerUser.mobile?.number ||
      peerUser.phone ||
      null;
    if (!raw) return null;
    try {
      return contactHasher.normalizePhoneNumber(String(raw)) || raw;
    } catch {
      return raw;
    }
  }, [peerUser]);

  // ── Check if peer is already in device contacts ─────────────────────────
  const checkIsUnknown = useCallback(async () => {
    if (!peerUser?._id || checkDoneRef.current) return;
    checkDoneRef.current = true;

    try {
      // 1. Check SQLite — if the contact exists with an original_id, it is known
      const dbContact = await ContactDatabase.getContactByUserId(String(peerUser._id));
      if (dbContact?.originalId) {
        setIsUnknown(false);
        return;
      }

      // 2. Fallback: search device contacts directly
      const normalizedPhone = getNormalizedPhone();
      if (!normalizedPhone) {
        setIsUnknown(false);
        return;
      }
      const deviceMatch = await findInDeviceContacts(normalizedPhone);
      setIsUnknown(!deviceMatch);
    } catch {
      setIsUnknown(false);
    }
  }, [peerUser, getNormalizedPhone]);

  useEffect(() => {
    checkDoneRef.current = false;
    setIsUnknown(false);
    setSavedSuccessfully(false);
    setSaveError(null);
    if (peerUser?._id) {
      checkIsUnknown();
    }
  }, [peerUser?._id, checkIsUnknown]);

  // ── Background contact:sync + chat list reload after a save ─────────────
  // 1) Lightweight notify to server (logs the save reason)
  // 2) Full `contact:sync` via refreshContacts — rehashes device contacts,
  //    re-matches against the server, updates SQLite via the contacts hook.
  // 3) Reloads chat list from the server so any new chat / updated peer
  //    names show up immediately on the chat list screen.
  const triggerContactSync = useCallback(() => {
    if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    syncDebounceRef.current = setTimeout(async () => {
      setIsSyncing(true);
      try {
        // (1) notify backend (Redis pub-sub trigger + analytics)
        try { socket?.emit?.('contact:sync:notify', { reason: 'save_contact' }); } catch {}

        // (2) Run the real `contact:sync` flow — this hashes the freshly-saved
        // device contact and uploads it; server returns the matched list and
        // the existing useContactSync hook updates SQLite + Redis cache.
        try {
          await refreshContacts({ fallbackToSync: true });
        } catch (err) {
          console.warn('[useSaveContact] refreshContacts failed:', err?.message);
        }

        // (3) Reload the chat list so the screen reflects the updated contact
        try {
          const action = dispatch(chatListData(''));
          if (action?.unwrap) {
            await action.unwrap().catch(() => {});
          }
        } catch (err) {
          console.warn('[useSaveContact] chatListData dispatch failed:', err?.message);
        }
      } catch (err) {
        console.warn('[useSaveContact] sync error:', err?.message);
      } finally {
        setIsSyncing(false);
      }
    }, SYNC_DEBOUNCE_MS);
  }, [socket, refreshContacts, dispatch]);

  // ── Main save handler ──────────────────────────────────────────────────
  const saveContact = useCallback(async () => {
    if (isSaving || savedSuccessfully || !peerUser) return;

    setSaveError(null);
    setIsSaving(true);

    try {
      const normalizedPhone = getNormalizedPhone();
      if (!normalizedPhone) {
        setSaveError('No phone number available');
        return;
      }

      // Derive name parts
      const fullName = peerUser.fullName || peerUser.name || peerUser.username || '';
      const nameParts = fullName.trim().split(/\s+/);
      const firstName = nameParts[0] || fullName;
      const lastName = nameParts.slice(1).join(' ') || '';

      const result = await saveToDeviceContacts({
        firstName,
        lastName,
        phone: normalizedPhone,
        imageUri: peerUser.profileImage || peerUser.profilePicture || null,
      });

      if (!result.success) {
        if (result.error === 'permission_denied') {
          setSaveError('permission_denied');
        } else {
          setSaveError(result.error || 'Failed to save contact');
        }
        return;
      }

      // Immediately update SQLite (keyed by canonical E.164)
      await upsertContactToSQLite({
        userId: String(peerUser._id || ''),
        fullName,
        normalizedPhone,
        profileImage: peerUser.profileImage || peerUser.profilePicture || null,
        phoneNumber: contactHasher.toE164(normalizedPhone),
      });

      setSavedSuccessfully(true);
      setIsUnknown(false);

      // Background sync to refresh the full contact list
      triggerContactSync();
    } catch (err) {
      setSaveError(err?.message || 'Failed to save contact');
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, savedSuccessfully, peerUser, getNormalizedPhone, triggerContactSync]);

  return {
    isUnknown,
    isSaving,
    isSyncing,
    savedSuccessfully,
    saveError,
    saveContact,
  };
};

export default useSaveContact;
