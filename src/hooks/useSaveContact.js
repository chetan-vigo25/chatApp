import { useState, useEffect, useCallback, useRef } from 'react';
import { useDispatch } from 'react-redux';
import { getSocket } from '../Redux/Services/Socket/socket';
import {
  findInDeviceContacts,
  isInDeviceContactsCached,
  invalidateDeviceContactsIndex,
  primeDeviceContactsIndex,
  saveToDeviceContacts,
  upsertContactToSQLite,
  getContactsPermissionStatus,
  requestContactsPermission,
} from '../services/SaveContactService';
import ContactDatabase from '../services/ContactDatabase';
import { subscribeContactsChanged } from '../services/contactEvents';
import contactHasher from '../Redux/Services/Contact/ContactHasher';
import useContactSync from '../contexts/useContactSync';
import { chatListData } from '../Redux/Reducer/Chat/Chat.reducer';

const SYNC_DEBOUNCE_MS = 1500;

/**
 * Status of the save-contact affordance for a peer.
 *
 *   'checking'    – still resolving; show nothing
 *   'permission'  – contacts access not granted, so we cannot know or save
 *   'needs_sync'  – access granted but this device has never completed a
 *                   contact sync; the peer may well BE saved, we just do not
 *                   know yet → offer "Sync contacts" first, never "unsaved"
 *   'unsaved'     – confirmed not in the device phone book → offer to save
 *   'saved'       – in the phone book (or just saved) → show nothing
 */
export const SAVE_CONTACT_STATUS = {
  CHECKING: 'checking',
  PERMISSION: 'permission',
  NEEDS_SYNC: 'needs_sync',
  UNSAVED: 'unsaved',
  SAVED: 'saved',
};

/**
 * Hook to manage the "Save Contact" flow for a peer user in a 1:1 chat.
 *
 * @param {object} peerUser - The peer user object from chatData.peerUser
 */
const useSaveContact = (peerUser) => {
  const [status, setStatus] = useState(SAVE_CONTACT_STATUS.CHECKING);
  const [isSaving, setIsSaving] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [savedSuccessfully, setSavedSuccessfully] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const syncDebounceRef = useRef(null);
  const mountedRef = useRef(true);
  // Callers build the peer object inline (`peerForSave = {...}` in UserB), so a
  // new identity arrives on EVERY render. Reading it through a ref keeps the
  // callbacks below stable — depending on the object directly re-created
  // resolveStatus each render, which re-fired the resolve effect in a loop and
  // left the status pinned at 'checking' (so the button never rendered).
  const peerRef = useRef(peerUser);
  peerRef.current = peerUser;
  const socket = getSocket();
  const dispatch = useDispatch();
  const { refreshContacts } = useContactSync();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    };
  }, []);

  // ── Derive normalized phone from peer user ──────────────────────────────
  const getNormalizedPhone = useCallback(() => {
    const peer = peerRef.current;
    if (!peer) return null;
    const raw =
      peer.mobileNumber ||
      peer.phoneNumber ||
      (peer.mobile?.number
        ? `${peer.mobile.code || ''}${peer.mobile.number}`
        : null) ||
      peer.phone ||
      null;
    if (!raw) return null;
    try {
      return contactHasher.toE164(String(raw)) || contactHasher.normalizePhoneNumber(String(raw)) || raw;
    } catch {
      return raw;
    }
  }, []);

  // ── Resolve the current status ──────────────────────────────────────────
  // Order matters: permission → sync-completed → phone book. Skipping the sync
  // gate is what made the app claim "not saved" for contacts that were saved on
  // the device but had simply never been synced into SQLite yet.
  //
  // TWO PHASES, because reading the whole address book takes seconds on a large
  // device and the user will not wait for a button:
  //   fast  — permission + cached phone-book index + SQLite; answers in ms.
  //   exact — builds/refreshes the phone-book index, then corrects the status.
  // The fast phase paints the button immediately; the exact phase can only ever
  // flip it to 'saved' (hiding it), never the other way, so nothing flickers in.
  const isSyncedEnough = useCallback(async () => {
    const [initialDone, count] = await Promise.all([
      ContactDatabase.isInitialSyncDone(),
      ContactDatabase.getContactCount(),
    ]);
    return Boolean(initialDone && count);
  }, []);

  const resolveFast = useCallback(async () => {
    const normalizedPhone = getNormalizedPhone();
    if (!normalizedPhone) return SAVE_CONTACT_STATUS.SAVED;

    const permission = await getContactsPermissionStatus();
    if (permission !== 'granted') return SAVE_CONTACT_STATUS.PERMISSION;

    // Already-built index → the real answer, instantly.
    const cached = isInDeviceContactsCached(normalizedPhone);
    if (cached === true) return SAVE_CONTACT_STATUS.SAVED;

    if (cached === null) {
      // Index not built yet. `contacts.full_name` means DEVICE-SAVED name and
      // nothing else (see the display-name rule), so a row carrying one is a
      // reliable enough "saved" to paint on — the exact phase confirms it.
      try {
        const peer = peerRef.current;
        const dbContact = peer?._id
          ? await ContactDatabase.getContactByUserId(String(peer._id))
          : await ContactDatabase.getContactByPhone(normalizedPhone);
        if (dbContact?.fullName) return SAVE_CONTACT_STATUS.SAVED;
      } catch { /* fall through — assume unsaved and let the exact phase fix it */ }
    }

    return (await isSyncedEnough())
      ? SAVE_CONTACT_STATUS.UNSAVED
      : SAVE_CONTACT_STATUS.NEEDS_SYNC;
  }, [getNormalizedPhone, isSyncedEnough]);

  const resolveExact = useCallback(async () => {
    const normalizedPhone = getNormalizedPhone();
    if (!normalizedPhone) return SAVE_CONTACT_STATUS.SAVED;

    const permission = await getContactsPermissionStatus();
    if (permission !== 'granted') return SAVE_CONTACT_STATUS.PERMISSION;

    // The device phone book is the ONLY source of truth for "is this saved".
    //
    // A SQLite `original_id` is NOT that signal: useContactSync falls back to
    // `contact.id` from the server payload when the device has no local entry,
    // so peers you have merely chatted with carry an original_id too. Trusting
    // it hid the "Save to contacts" button for every unsaved number.
    const deviceMatch = await findInDeviceContacts(normalizedPhone);
    if (deviceMatch) return SAVE_CONTACT_STATUS.SAVED;

    // Not in the phone book. Before telling the user that, make sure this
    // device has actually synced its contacts — an unsynced device shows plain
    // numbers everywhere, and "Save contact" would be the wrong prompt.
    return (await isSyncedEnough())
      ? SAVE_CONTACT_STATUS.UNSAVED
      : SAVE_CONTACT_STATUS.NEEDS_SYNC;
  }, [getNormalizedPhone, isSyncedEnough]);

  const resolveInFlightRef = useRef(false);

  const refreshStatus = useCallback(async ({ force = false } = {}) => {
    if (resolveInFlightRef.current && !force) return undefined;
    resolveInFlightRef.current = true;
    try {
      const fast = await resolveFast();
      if (mountedRef.current) setStatus(fast);

      const exact = await resolveExact();
      if (mountedRef.current) setStatus(exact);
      return exact;
    } catch {
      if (mountedRef.current) setStatus(SAVE_CONTACT_STATUS.SAVED);
      return SAVE_CONTACT_STATUS.SAVED;
    } finally {
      resolveInFlightRef.current = false;
    }
  }, [resolveFast, resolveExact]);

  // Keyed on the id AND the number: a profile screen mounts with the peer id
  // first and fills the number in a moment later. Keying on the id alone froze
  // the first (number-less) resolution — the status stayed 'saved' and the
  // button never appeared once the number arrived.
  const peerKey = `${peerUser?._id || ''}|${getNormalizedPhone() || ''}`;

  useEffect(() => {
    setStatus(SAVE_CONTACT_STATUS.CHECKING);
    setSavedSuccessfully(false);
    setSaveError(null);
    if (peerKey === '|') {
      setStatus(SAVE_CONTACT_STATUS.SAVED);
      return;
    }
    refreshStatus();
  }, [peerKey, refreshStatus]);

  // Re-resolve whenever the local contacts table changes (a sync landed, the
  // peer joined, a save was mirrored) so the banner disappears on its own.
  useEffect(() => {
    if (peerKey === '|') return undefined;
    return subscribeContactsChanged(() => {
      // A sync/save just wrote to the contacts table — the phone book may have
      // changed with it, so the cached index must not answer from before.
      invalidateDeviceContactsIndex();
      refreshStatus({ force: true });
    });
  }, [peerKey, refreshStatus]);

  // ── Background contact:sync + chat list reload after a save ─────────────
  // 1) Lightweight notify to server (logs the save reason)
  // 2) Full `contact:sync` via refreshContacts — re-reads device contacts,
  //    re-matches against the server, updates SQLite via the contacts hook.
  // 3) Reloads chat list from the server so any new chat / updated peer
  //    names show up immediately on the chat list screen.
  const runSync = useCallback(async ({ reason = 'save_contact', reloadChatList = true } = {}) => {
    setIsSyncing(true);
    try {
      try { socket?.emit?.('contact:sync:notify', { reason }); } catch {}

      try {
        // Background resync — never alerts about a denied contacts permission
        // (the save itself already succeeded); a user-pressed Refresh does.
        await refreshContacts({ fallbackToSync: true, userInitiated: false });
      } catch (err) {
        console.warn('[useSaveContact] refreshContacts failed:', err?.message);
      }

      if (reloadChatList) {
        try {
          const action = dispatch(chatListData(''));
          if (action?.unwrap) await action.unwrap().catch(() => {});
        } catch (err) {
          console.warn('[useSaveContact] chatListData dispatch failed:', err?.message);
        }
      }
    } catch (err) {
      console.warn('[useSaveContact] sync error:', err?.message);
    } finally {
      if (mountedRef.current) setIsSyncing(false);
      await refreshStatus();
    }
  }, [socket, refreshContacts, dispatch, refreshStatus]);

  const triggerContactSync = useCallback(() => {
    if (syncDebounceRef.current) clearTimeout(syncDebounceRef.current);
    syncDebounceRef.current = setTimeout(() => { runSync({ reason: 'save_contact' }); }, SYNC_DEBOUNCE_MS);
  }, [runSync]);

  // ── Public: user-triggered contact sync (the 'needs_sync' CTA) ──────────
  const syncNow = useCallback(async () => {
    if (isSyncing) return;
    const granted = await requestContactsPermission();
    if (!granted) {
      setSaveError('permission_denied');
      await refreshStatus();
      return;
    }
    setSaveError(null);
    await runSync({ reason: 'manual_sync', reloadChatList: false });
  }, [isSyncing, runSync, refreshStatus]);

  // ── Public: grant contacts permission (the 'permission' CTA) ────────────
  const requestPermission = useCallback(async () => {
    const granted = await requestContactsPermission();
    setSaveError(granted ? null : 'permission_denied');
    await refreshStatus();
    return granted;
  }, [refreshStatus]);

  // ── Main save handler ──────────────────────────────────────────────────
  const saveContact = useCallback(async () => {
    const peerUser = peerRef.current;
    if (isSaving || !peerUser) return;

    setSaveError(null);
    setIsSaving(true);

    try {
      const normalizedPhone = getNormalizedPhone();
      if (!normalizedPhone) {
        setSaveError('No phone number available');
        return;
      }

      // Derive name parts. The server's name is a PUSH name — it is only a
      // suggestion pre-filled into the form, which the user can edit.
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
        } else if (result.error === 'not_saved') {
          // Form closed without saving — stay on the "unsaved" state silently.
          setSaveError(null);
        } else {
          setSaveError(result.error || 'Failed to save contact');
        }
        await refreshStatus();
        return;
      }

      // Mirror into SQLite (keyed by canonical E.164) so names resolve at once.
      const e164 = contactHasher.toE164(normalizedPhone) || normalizedPhone;
      await upsertContactToSQLite({
        userId: String(peerUser._id || ''),
        fullName,
        normalizedPhone,
        profileImage: peerUser.profileImage || peerUser.profilePicture || null,
        phoneNumber: e164,
        originalId: result.contactId || null,
      });

      invalidateDeviceContactsIndex();
      setSavedSuccessfully(true);
      setStatus(SAVE_CONTACT_STATUS.SAVED);

      // Background sync to refresh the full contact list
      triggerContactSync();
    } catch (err) {
      setSaveError(err?.message || 'Failed to save contact');
    } finally {
      if (mountedRef.current) setIsSaving(false);
    }
  }, [isSaving, getNormalizedPhone, triggerContactSync, refreshStatus]);

  return {
    status,
    // Back-compat flag used by existing screens.
    isUnknown: status === SAVE_CONTACT_STATUS.UNSAVED,
    needsSync: status === SAVE_CONTACT_STATUS.NEEDS_SYNC,
    needsPermission: status === SAVE_CONTACT_STATUS.PERMISSION,
    isSaving,
    isSyncing,
    savedSuccessfully,
    saveError,
    saveContact,
    syncNow,
    requestPermission,
    refreshStatus,
  };
};

export default useSaveContact;
