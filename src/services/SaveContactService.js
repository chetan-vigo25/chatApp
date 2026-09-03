import * as Contacts from 'expo-contacts';
import { Platform } from 'react-native';
import contactHasher from '../Redux/Services/Contact/ContactHasher';
import ContactDatabase from './ContactDatabase';
import { suspendAppLock, resumeAppLock } from './appLockGuard';

/**
 * Request contacts permission. Returns true if granted.
 * Wrapped in the app-lock suspend guard — the OS permission dialog backgrounds
 * the app on many devices, and the return trip must not re-trigger the lock.
 */
export const requestContactsPermission = async () => {
  suspendAppLock();
  try {
    const { status } = await Contacts.requestPermissionsAsync();
    return status === 'granted';
  } finally {
    resumeAppLock();
  }
};

/**
 * Current contacts permission status without prompting.
 * Returns 'granted' | 'denied' | 'undetermined'.
 */
export const getContactsPermissionStatus = async () => {
  try {
    const { status } = await Contacts.getPermissionsAsync();
    return status;
  } catch {
    return 'undetermined';
  }
};

// Two device numbers refer to the same person when their significant digits
// match. "Significant" = the last 9 digits (national number minus trunk/area
// noise) — never a bare `endsWith`, which made a 4-digit shortcode match every
// number on the device and silently reported unsaved contacts as saved.
const SIGNIFICANT_DIGITS = 9;

const digitsOf = (v) => String(v || '').replace(/[^\d]/g, '');

export const samePhoneNumber = (a, b) => {
  const da = digitsOf(a);
  const db = digitsOf(b);
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length < 7 || db.length < 7) return false;
  const len = Math.min(SIGNIFICANT_DIGITS, da.length, db.length);
  return da.slice(-len) === db.slice(-len);
};

// ── Device phone-book index ────────────────────────────────────────────────
// Reading the whole address book takes seconds on a large device, and doing it
// on every profile open is what made the "Save to contacts" button appear ~5s
// late. The numbers are read ONCE into a Set of significant-digit keys, then
// every later lookup is O(1) and synchronous.
//
// The cache is invalidated after a save, and expires on its own so contacts
// added outside the app are picked up without a restart.
const INDEX_TTL_MS = 5 * 60 * 1000;

let deviceIndex = null;        // Set<string> of significant-digit keys
let deviceIndexAt = 0;
let deviceIndexPromise = null; // in-flight build, so N callers share one read

const keysForNumber = (raw) => {
  const d = digitsOf(raw);
  if (!d || d.length < 7) return [];
  // Index both the full digit string and its significant tail so numbers stored
  // with and without a country code still meet on a common key.
  const tail = d.slice(-SIGNIFICANT_DIGITS);
  return d === tail ? [d] : [d, tail];
};

const buildDeviceIndex = async () => {
  const { data } = await Contacts.getContactsAsync({
    fields: [Contacts.Fields.PhoneNumbers],
  });
  const set = new Set();
  for (const contact of data || []) {
    for (const pn of contact.phoneNumbers || []) {
      for (const key of keysForNumber(pn.number || pn.digits)) set.add(key);
    }
  }
  return set;
};

const getDeviceIndex = async ({ force = false } = {}) => {
  const fresh = deviceIndex && Date.now() - deviceIndexAt < INDEX_TTL_MS;
  if (!force && fresh) return deviceIndex;
  if (!force && deviceIndexPromise) return deviceIndexPromise;

  deviceIndexPromise = (async () => {
    try {
      const set = await buildDeviceIndex();
      deviceIndex = set;
      deviceIndexAt = Date.now();
      return set;
    } catch {
      return deviceIndex || new Set();
    } finally {
      deviceIndexPromise = null;
    }
  })();
  return deviceIndexPromise;
};

/** Drop the cached phone-book index (after a save, or a known external change). */
export const invalidateDeviceContactsIndex = () => {
  deviceIndex = null;
  deviceIndexAt = 0;
};

/**
 * Warm the index in the background. Call it when a screen that will need a
 * lookup mounts, so the answer is already there by the time it is asked for.
 */
export const primeDeviceContactsIndex = async () => {
  try {
    const { status } = await Contacts.getPermissionsAsync();
    if (status !== 'granted') return;
    await getDeviceIndex();
  } catch { /* best effort */ }
};

/**
 * Synchronous lookup against the cached index.
 * Returns true / false, or `null` when the index has not been built yet — the
 * caller decides whether to wait or paint an optimistic answer.
 */
export const isInDeviceContactsCached = (normalizedPhone) => {
  if (!deviceIndex || !normalizedPhone) return null;
  return keysForNumber(normalizedPhone).some((k) => deviceIndex.has(k));
};

/**
 * Check if a normalized phone number already exists in device contacts.
 * Returns a truthy match marker or null.
 *
 * Never throws and never prompts — a missing permission simply returns null,
 * which callers must NOT read as "already saved" (see getContactsPermissionStatus).
 */
export const findInDeviceContacts = async (normalizedPhone, { force = false } = {}) => {
  if (!normalizedPhone) return null;
  try {
    const { status } = await Contacts.getPermissionsAsync();
    if (status !== 'granted') return null;

    const index = await getDeviceIndex({ force });
    const hit = keysForNumber(normalizedPhone).some((k) => index.has(k));
    return hit ? { matched: true } : null;
  } catch {
    return null;
  }
};

/**
 * Poll the device phone book until the number shows up (or we give up).
 *
 * Android's native "Create contact" form resolves as soon as it closes — saved
 * or cancelled, we cannot tell — and the ContactsProvider write lands a beat
 * later. Without this check the app announced "Contact saved" for numbers the
 * user never saved, which is exactly the reported bug.
 */
export const verifySavedToDevice = async (normalizedPhone, { attempts = 5, delayMs = 400 } = {}) => {
  invalidateDeviceContactsIndex();
  for (let i = 0; i < attempts; i++) {
    // force: a save just happened, so the cached index is stale by definition.
    const match = await findInDeviceContacts(normalizedPhone, { force: true });
    if (match) return match;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return null;
};

/**
 * Save a contact to the device phone book.
 *
 * Works on ANY device: a silent `addContactAsync` is attempted first (succeeds
 * wherever a writable account/profile exists, on both platforms), and when the
 * OS refuses it we fall back to `presentFormAsync` — the native "Add contact"
 * form pre-filled, where the user taps Save.
 *
 * Success is only reported after the number is actually found in the phone
 * book, because presentFormAsync resolves identically for save and cancel.
 *
 * Returns { success, verified, contactId, error }; error 'not_saved' means the
 * form was closed without saving.
 */
export const saveToDeviceContacts = async ({ firstName, lastName, phone, imageUri } = {}) => {
  // The whole flow (permission dialog + system "Create contact" form) leaves
  // the app — suspend the app lock for the round trip so the user isn't
  // dumped on the lock screen after saving a contact.
  suspendAppLock();
  try {
  const granted = await requestContactsPermission();
  if (!granted) {
    return { success: false, error: 'permission_denied' };
  }

  // Use plain camelCase keys — expo-contacts' presentFormAsync on Android
  // mis-maps fields when ContactType / combined Name keys are also present,
  // which is what caused the phone number to land in the email slot.
  const phoneStr = String(phone || '').trim();
  const contactData = {
    firstName: firstName || '',
    lastName: lastName || '',
    phoneNumbers: [
      {
        label: 'mobile',
        number: phoneStr,
        digits: phoneStr.replace(/[^\d+]/g, ''),
        isPrimary: true,
      },
    ],
  };

  if (imageUri && Platform.OS === 'ios') {
    contactData.image = { uri: imageUri };
  }

  // Try a silent insert first — on devices with a writable account this saves
  // the contact outright, which is what the user asked for ("contact saved bhi
  // hone chahiye"). Only when that is not possible do we fall back to the
  // native form, which requires the extra tap.
  const trySilentInsert = async () => {
    try {
      const contactId = await Contacts.addContactAsync(contactData);
      return { ok: true, contactId };
    } catch (err) {
      return { ok: false, error: err };
    }
  };

  const tryForm = async () => {
    try {
      // presentFormAsync opens the system "Create contact" UI pre-filled.
      // Resolves when the user closes the form (saved OR cancelled) — the
      // caller must verify against the phone book before claiming success.
      await Contacts.presentFormAsync(null, contactData, {
        allowsEditing: true,
        cancelButtonTitle: 'Cancel',
      });
      return { ok: true, contactId: null };
    } catch (err) {
      return { ok: false, error: err };
    }
  };

  const silent = await trySilentInsert();
  if (silent.ok) {
    const verified = await verifySavedToDevice(phoneStr, { attempts: 3, delayMs: 250 });
    if (verified) return { success: true, verified: true, contactId: silent.contactId };
  }

  const permissionish = (err) =>
    String(err?.message || '').toLowerCase().includes('permission');
  if (!silent.ok && permissionish(silent.error)) {
    return { success: false, verified: false, error: 'permission_denied' };
  }

  const form = await tryForm();
  if (!form.ok) {
    const msg = String(form.error?.message || silent.error?.message || '');
    if (permissionish(form.error)) {
      return { success: false, verified: false, error: 'permission_denied' };
    }
    return { success: false, verified: false, error: msg || 'save_failed' };
  }

  // Form closed — confirm the contact really landed in the phone book.
  const verified = await verifySavedToDevice(phoneStr);
  if (verified) {
    return { success: true, verified: true, contactId: verified.id || null };
  }
  return { success: false, verified: false, error: 'not_saved' };
  } finally {
    resumeAppLock();
  }
};

/**
 * After saving to device, upsert the contact into local SQLite so the
 * app reflects it immediately without waiting for a full server sync.
 */
export const upsertContactToSQLite = async ({
  userId,
  fullName,
  normalizedPhone,
  profileImage,
  phoneNumber, // canonical E.164 (preferred)
  originalId,  // device phone-book contact id, when the OS gave us one
}) => {
  try {
    const now = Date.now();
    // Canonical E.164 is the primary key. Derive it from whatever was passed.
    const e164 = phoneNumber || (normalizedPhone ? contactHasher.toE164(normalizedPhone) : null);

    if (!e164) return;

    await ContactDatabase.upsertContacts([{
      phoneNumber: e164,
      originalId: originalId || null,
      userId: userId || null,
      type: userId ? 'registered' : 'unregistered',
      fullName: fullName || '',
      normalizedPhone: e164,
      profileImage: profileImage || null,
      isActive: true,
      canMessage: !!userId,
      synced_at: now,
      updated_at: now,
    }]);
  } catch (err) {
    console.warn('[SaveContactService] upsertContactToSQLite error:', err?.message);
  }
};
