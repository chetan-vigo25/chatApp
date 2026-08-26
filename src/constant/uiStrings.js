/**
 * Curated translations for the app's own UI labels.
 *
 * ── Why this exists instead of just letting ML Kit do it ─────────────────────
 * Machine translation is at its worst on exactly the strings a UI is made of:
 * two words, no sentence, no context. Real labels from this app:
 *
 *   "Save"       — save a file? save a contact? rescue someone?
 *   "Call"       — the noun, or the verb?
 *   "Clear chat" — empty it, or "chat that is easy to understand"?
 *   "View once"  — a product feature name, not an instruction
 *   "On TalksTry"— a BRAND NAME that must survive untouched
 *
 * ML Kit is the right tool for chat messages, which are real sentences nobody
 * can predict. It is the wrong tool for a fixed set of a few hundred labels
 * that ship with the app and can simply be translated properly, once.
 *
 * So: this table is checked FIRST. A hit is instant, correct, needs no 30MB
 * model and no CPU. A miss falls through to ML Kit, which still covers
 * everything not listed here.
 *
 * ── Adding a language ────────────────────────────────────────────────────────
 * Add a key, copy the English keys, translate the values. Anything you leave
 * out simply falls through — a partial table is fine and is better than none.
 *
 * ⚠️  HAVE A NATIVE SPEAKER REVIEW THESE. They are a starting point, not
 *     finished localisation. A wrong UI label is more visible than a wrong
 *     message translation because every user sees it on every screen.
 */

/**
 * Strings that must NEVER be translated, in any language.
 *
 * Brand names, protocol names and units. Without this, "On TalksTry" becomes
 * nonsense and "SMS" turns into a phonetic transliteration.
 */
export const NEVER_TRANSLATE = new Set([
  'TalksTry',
  'On TalksTry',
  'SMS',
  'OK',
  'GIF',
  'PDF',
  'QR',
  'ID',
]);

/**
 * language → { English label: translated label }
 *
 * Keys must match the source string EXACTLY as it appears in the JSX, including
 * capitalisation — the lookup is a plain map, not fuzzy.
 */
export const UI_STRINGS = {
  hi: {
    Save: 'सहेजें',
    Saved: 'सहेजा गया',
    Cancel: 'रद्द करें',
    Cancelled: 'रद्द',
    Retry: 'फिर कोशिश करें',
    Settings: 'सेटिंग्स',
    Message: 'संदेश',
    Call: 'कॉल',
    Mobile: 'मोबाइल',
    Offline: 'ऑफ़लाइन',
    Forwarded: 'अग्रेषित',
    Unblock: 'अनब्लॉक करें',
    'Log out': 'लॉग आउट',
    'Clear chat': 'चैट साफ़ करें',
    'Clear for all': 'सबके लिए साफ़ करें',
    'Save Contact': 'संपर्क सहेजें',
    'View once': 'एक बार देखें',
    'Choose your language': 'अपनी भाषा चुनें',
    'Search language': 'भाषा खोजें',
    'No language found': 'कोई भाषा नहीं मिली',
    // Screens opted in so far: Settings, Chat privacy, Privacy & Account,
    // Blocked contacts, Delete account, Two-step password, Calls.
    Calls: 'कॉल',
    Clear: 'साफ़ करें',
    Continue: 'जारी रखें',
    Delete: 'हटाएं',
    Today: 'आज',
    Yesterday: 'कल',
    Earlier: 'पहले',
    'Chat Privacy': 'चैट गोपनीयता',
    'Blocked Contacts': 'अवरुद्ध संपर्क',
    'Privacy & Account': 'गोपनीयता और खाता',
    'Delete My Account': 'मेरा खाता हटाएं',
    'Delete Account': 'खाता हटाएं',
    SECURITY: 'सुरक्षा',
    RECOVERY: 'पुनर्प्राप्ति',
    STATUS: 'स्थिति',
  },

  // Starter set only — the labels most visible in the app. Extend as screens
  // opt in; anything missing falls through to ML Kit rather than breaking.
  th: {
    Save: 'บันทึก',
    Saved: 'บันทึกแล้ว',
    Cancel: 'ยกเลิก',
    Retry: 'ลองอีกครั้ง',
    Settings: 'การตั้งค่า',
    Message: 'ข้อความ',
    Call: 'โทร',
    Mobile: 'มือถือ',
    Offline: 'ออฟไลน์',
    'Log out': 'ออกจากระบบ',
    'Choose your language': 'เลือกภาษาของคุณ',
    'Search language': 'ค้นหาภาษา',
    'No language found': 'ไม่พบภาษา',
    Calls: 'สายโทร',
    Clear: 'ล้าง',
    Continue: 'ดำเนินการต่อ',
    Delete: 'ลบ',
    Today: 'วันนี้',
    Yesterday: 'เมื่อวาน',
    Earlier: 'ก่อนหน้านี้',
    'Chat Privacy': 'ความเป็นส่วนตัวของแชท',
    'Blocked Contacts': 'รายชื่อที่ถูกบล็อก',
    'Privacy & Account': 'ความเป็นส่วนตัวและบัญชี',
    'Delete Account': 'ลบบัญชี',
  },
};

/**
 * Look up a curated label.
 *
 * Returns the translated string, the ORIGINAL for never-translate terms, or
 * null to mean "not curated — let ML Kit try".
 */
export function lookupUiString(text, language) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (NEVER_TRANSLATE.has(trimmed)) return trimmed;
  return UI_STRINGS[language]?.[trimmed] ?? null;
}
