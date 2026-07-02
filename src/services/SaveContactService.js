import * as Contacts from 'expo-contacts';
import { Platform } from 'react-native';
import contactHasher from '../Redux/Services/Contact/ContactHasher';
import ContactDatabase from './ContactDatabase';

/**
 * Request contacts permission. Returns true if granted.
 */
export const requestContactsPermission = async () => {
  const { status } = await Contacts.requestPermissionsAsync();
  return status === 'granted';
};

/**
 * Check if a normalized phone number already exists in device contacts.
 * Returns the matching device contact or null.
 */
export const findInDeviceContacts = async (normalizedPhone) => {
  if (!normalizedPhone) return null;
  try {
    const { status } = await Contacts.getPermissionsAsync();
    if (status !== 'granted') return null;

    const { data } = await Contacts.getContactsAsync({
      fields: [Contacts.Fields.PhoneNumbers],
    });

    const strippedTarget = normalizedPhone.replace(/[^\d]/g, '');

    for (const contact of data) {
      for (const pn of contact.phoneNumbers || []) {
        const stripped = (pn.number || '').replace(/[^\d]/g, '');
        if (
          stripped === strippedTarget ||
          strippedTarget.endsWith(stripped) ||
          stripped.endsWith(strippedTarget)
        ) {
          return contact;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * Save a contact to the device phone book.
 *
 * On Android, `addContactAsync` regularly fails with native errors because it
 * requires WRITE_CONTACTS + a writable account/profile to insert into. The
 * reliable approach is `presentFormAsync`, which opens the native "Add contact"
 * form pre-filled — the user just taps Save. iOS supports `addContactAsync`
 * directly so we keep that fast path there.
 *
 * Returns { success, contactId, error }.
 */
export const saveToDeviceContacts = async ({ firstName, lastName, phone, imageUri } = {}) => {
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

  // ── Android path: open native contact form (no WRITE_CONTACTS needed) ──
  if (Platform.OS === 'android') {
    try {
      // presentFormAsync opens the system "Create contact" UI pre-filled.
      // Resolves when the user closes the form (saved or cancelled).
      await Contacts.presentFormAsync(null, contactData, {
        allowsEditing: true,
        cancelButtonTitle: 'Cancel',
      });
      return { success: true, contactId: null };
    } catch (err) {
      // Fallback: try addContactAsync (works on devices with a writable account)
      try {
        const contactId = await Contacts.addContactAsync(contactData);
        return { success: true, contactId };
      } catch (innerErr) {
        const msg = String(innerErr?.message || err?.message || '');
        if (msg.toLowerCase().includes('permission')) {
          return { success: false, error: 'permission_denied' };
        }
        return { success: false, error: msg || 'save_failed' };
      }
    }
  }

  // ── iOS path: direct insert ──
  try {
    const contactId = await Contacts.addContactAsync(contactData);
    return { success: true, contactId };
  } catch (err) {
    // Fallback to native form on iOS too
    try {
      await Contacts.presentFormAsync(null, contactData, {
        allowsEditing: true,
        cancelButtonTitle: 'Cancel',
      });
      return { success: true, contactId: null };
    } catch (innerErr) {
      return { success: false, error: innerErr?.message || err?.message || 'save_failed' };
    }
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
}) => {
  try {
    const now = Date.now();
    // Canonical E.164 is the primary key. Derive it from whatever was passed.
    const e164 = phoneNumber || (normalizedPhone ? contactHasher.toE164(normalizedPhone) : null);

    if (!e164) return;

    await ContactDatabase.upsertContacts([{
      phoneNumber: e164,
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
