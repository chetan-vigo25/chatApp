import AsyncStorage from '@react-native-async-storage/async-storage';

// Local, on-device store for the "deleted chats password" automation.
//
// The password itself is verified server-side (bcrypt) — we never keep it
// here. What we DO keep is the user's pre-armed selection: which chats to
// purge and the delete scope ("me" | "everyone"). When the matching password
// is entered at the login gate, this config is read back and executed
// automatically. It is per-device by design (a local panic switch).
const DELETED_CHAT_CONFIG_KEY = '@chat/deletedChatConfig';

// Cached boolean flag mirroring whether a deleted-chats password is currently
// set on the server. The single app-lock overlay (components/AppLockGate)
// reads this — alongside TWO_STEP_ENABLED_KEY — to decide whether to arm the
// lock on cold start / foreground, so the deleted-chats password can be
// entered on the same screen as the 2-step password. Keep in sync with
// AppLockGate.js.
export const DELETED_PWD_SET_KEY = '@chat/deletedPwdSet';

// Mark whether a deleted-chats password is set (mirrors the server flag).
export async function markDeletedPasswordSet(isSet) {
  try {
    await AsyncStorage.setItem(DELETED_PWD_SET_KEY, isSet ? '1' : '0');
  } catch {
    /* best-effort */
  }
}

const normalizeScope = (scope) => (scope === 'everyone' ? 'everyone' : 'me');

const normalizeIds = (ids) =>
  Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)).filter(Boolean)));

// Persist the armed selection. Pass { scope, chatIds }.
export async function saveDeletedChatConfig({ scope, chatIds } = {}) {
  const payload = {
    scope: normalizeScope(scope),
    chatIds: normalizeIds(chatIds),
    updatedAt: Date.now(),
  };
  try {
    await AsyncStorage.setItem(DELETED_CHAT_CONFIG_KEY, JSON.stringify(payload));
    return payload;
  } catch {
    return null;
  }
}

// Read the armed selection back, or null if nothing has been configured.
export async function getDeletedChatConfig() {
  try {
    const raw = await AsyncStorage.getItem(DELETED_CHAT_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const chatIds = normalizeIds(parsed?.chatIds);
    if (chatIds.length === 0) return null;
    return {
      scope: normalizeScope(parsed?.scope),
      chatIds,
      updatedAt: Number(parsed?.updatedAt) || 0,
    };
  } catch {
    return null;
  }
}

// Wipe the armed selection (used when the password is reset).
export async function clearDeletedChatConfig() {
  try {
    await AsyncStorage.removeItem(DELETED_CHAT_CONFIG_KEY);
  } catch {
    /* best-effort */
  }
}
