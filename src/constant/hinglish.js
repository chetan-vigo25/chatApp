/**
 * Romanized Hindi → English, entirely on-device.
 *
 * ── What this is for ─────────────────────────────────────────────────────────
 * ML Kit cannot read "chale chalo": its hi→x model wants Devanagari and its
 * en→x model wants real English. The cloud fallback solves that properly but
 * needs a backend route and costs money per character.
 *
 * This is the offline half. It maps common romanized phrases to English, and
 * ML Kit then translates that English into ANY of the app's languages on the
 * device:
 *
 *     "chale chalo" → (this table) → "let's go" → (ML Kit en→th) → "ไปกันเถอะ"
 *
 * One table, every target language, zero network, zero cost.
 *
 * ── What this is NOT ─────────────────────────────────────────────────────────
 * Not a translator. It only knows the phrases listed here. Chat is open-ended,
 * so plenty of real messages will miss and fall through to the cloud fallback
 * (or stay as typed if that is not deployed). Building something that handles
 * arbitrary romanized Hindi needs a trained model, not a lookup table — a
 * rule-based transliterator was measured getting 6/6 test phrases wrong.
 *
 * ── Growing it ───────────────────────────────────────────────────────────────
 * This pays off exactly in proportion to how well it matches what YOUR users
 * type. Log the misses in production, sort by frequency, add the top ones.
 * Every entry added is a message that stops needing the network forever.
 */

/**
 * Spelling variants folded to one canonical form BEFORE lookup.
 *
 * Romanized Hindi has no standard orthography — "nahi", "nahin", "nhi" and
 * "nahee" are the same word. Without this fold each variant would need its own
 * entry, and each would miss the cache separately.
 */
const SPELLING_VARIANTS = {
  nhi: 'nahi', nahin: 'nahi', nahee: 'nahi', nai: 'nahi',
  kia: 'kya', kyaa: 'kya', kaa: 'kya',
  hain: 'hai', hei: 'hai', h: 'hai', hy: 'hai',
  kr: 'kar', krr: 'kar',
  rha: 'raha', rhaa: 'raha', rhe: 'rahe', rhi: 'rahi',
  hu: 'hoon', hoo: 'hoon', hun: 'hoon',
  tum: 'tum', tu: 'tum', aap: 'aap',
  kaisa: 'kaisa', kesa: 'kaisa', kese: 'kaise', kaise: 'kaise',
  acha: 'accha', achha: 'accha', achcha: 'accha',
  thik: 'theek', theak: 'theek', thk: 'theek',
  bhut: 'bahut', bohot: 'bahut', bht: 'bahut',
  abi: 'abhi', abhee: 'abhi',
  chalo: 'chalo', chlo: 'chalo', chale: 'chale', chle: 'chale',
  batao: 'batao', btao: 'batao', bta: 'batao',
  kaha: 'kahan', khan: 'kahan',
  // NOT `kha: 'kahan'` — in chat "kha" is nearly always "khaa" (eat), so that
  // mapping turned "khana kha liya" into "khana kahan liya" and inverted the
  // meaning. Ambiguous short forms belong in PHRASES, not here.
  kyu: 'kyun', kyo: 'kyun', kyun: 'kyun',
  mujhe: 'mujhe', muje: 'mujhe', mje: 'mujhe',
  tumhe: 'tumhe', tume: 'tumhe',
  karo: 'karo', kro: 'karo',
  gaya: 'gaya', gya: 'gaya',
  liye: 'liye', lie: 'liye',
  yaar: 'yaar', yr: 'yaar', yar: 'yaar',
  plz: 'please', pls: 'please',
  pta: 'pata', ptaa: 'pata',
  mt: 'mat',
  baki: 'baaki', bki: 'baaki',
  jaunga: 'jaunga', jaaunga: 'jaunga',
  aaye: 'aaye', aye: 'aaye',
  gaye: 'gaye', gye: 'gaye',
  liya: 'liya', lia: 'liya',
  bhejo: 'bhejo', bhjo: 'bhejo',
  thoda: 'thoda', thora: 'thoda', thda: 'thoda',
  baje: 'baje', bje: 'baje',
  baat: 'baat', bat: 'baat',
  kaam: 'kaam', kam: 'kaam',
  ghar: 'ghar', ghr: 'ghar',
};

/**
 * Canonical romanized phrase → English.
 *
 * Keys must already be normalised (lowercase, variants folded) — see
 * `normalizeHinglish`. Values are plain English so ML Kit can take them the
 * rest of the way.
 */
const PHRASES = {
  // greetings / openers
  'namaste': 'hello',
  'kaise ho': 'how are you',
  'kaisi ho': 'how are you',
  'kaise hai': 'how are you',
  'kaise ho aap': 'how are you',
  'kya haal hai': 'how are you',
  'kya hai': 'what is it',
  'kya hua': 'what happened',
  'sab theek hai': 'everything is fine',
  'main theek hoon': 'i am fine',
  'aur batao': 'tell me more',
  'batao': 'tell me',
  'abhi batao': 'tell me now',

  // the phrases from the device test
  'chale chalo': "let's go",
  'chalo': "let's go",
  'chalte hai': "let's go",
  'abhi nahi': 'not now',
  'abhi nahi yaar': 'not now',

  // yes / no / ack
  'haan': 'yes',
  'ha': 'yes',
  'nahi': 'no',
  'theek hai': 'okay',
  'ok': 'okay',
  'accha': 'okay',
  'accha theek hai': 'alright then',
  'ho gaya': 'it is done',
  'nahi hua': 'it did not happen',
  'pata nahi': 'i do not know',
  'malum nahi': 'i do not know',
  'samajh gaya': 'understood',
  'samajh nahi aaya': 'i did not understand',

  // common questions
  'kya kar rahe ho': 'what are you doing',
  'kya kar rahi ho': 'what are you doing',
  'kahan ho': 'where are you',
  'kahan hai': 'where is it',
  'kab aaoge': 'when will you come',
  'kab aayega': 'when will it come',
  'kyun': 'why',
  'kaun hai': 'who is it',
  'kitna hai': 'how much is it',
  'kitne baje': 'what time',

  // requests
  'suno': 'listen',
  'ek minute': 'one minute',
  'ruko': 'wait',
  'jaldi karo': 'hurry up',
  'call karo': 'call me',
  'message karo': 'message me',
  'bhej do': 'send it',
  'bhejo': 'send it',
  'dekh lo': 'take a look',
  'dekho': 'look',
  'please batao': 'please tell me',

  // closings
  'theek hai bye': 'okay bye',
  'milte hai': 'see you',
  'baad me baat karte hai': "let's talk later",
  'good night': 'good night',
  'shukriya': 'thank you',
  'dhanyawad': 'thank you',
  'koi baat nahi': 'no problem',
  'maaf karna': 'sorry',
  'sorry yaar': 'sorry',

  // frequent fragments
  'main aa raha hoon': 'i am coming',
  'main aa rahi hoon': 'i am coming',
  'aa jao': 'come over',
  'ghar pe hoon': 'i am at home',
  'bahar hoon': 'i am out',
  'busy hoon': 'i am busy',
  'baad me': 'later',
  'kal': 'tomorrow',
  'aaj': 'today',
  'abhi': 'right now',
  'bahut accha': 'very good',
  'bahut bura': 'very bad',

  // ── questions ──────────────────────────────────────────────────────────────
  'kya kar rahe the': 'what were you doing',
  'kya hua tha': 'what had happened',
  'kya baat hai': 'what is the matter',
  'kya chahiye': 'what do you need',
  'kya bola': 'what did you say',
  'kya matlab': 'what do you mean',
  'kaun bol raha hai': 'who is speaking',
  'kitne log': 'how many people',
  'kitni der': 'how long',
  'kab tak': 'until when',
  'kab milenge': 'when will we meet',
  'kahan jaa rahe ho': 'where are you going',
  'kahan se': 'from where',
  'kaise kare': 'how to do it',
  'kyun nahi': 'why not',
  'sach me': 'really',
  'pakka': 'for sure',
  'kaun': 'who',
  'kahan': 'where',
  'kab': 'when',
  'kaise': 'how',
  'kitna': 'how much',

  // ── answers / reactions ────────────────────────────────────────────────────
  'bilkul': 'absolutely',
  'shayad': 'maybe',
  'ho sakta hai': 'it is possible',
  'nahi pata': 'i do not know',
  'mujhe nahi pata': 'i do not know',
  'zaroor': 'definitely',
  'bilkul nahi': 'absolutely not',
  'koi nahi': 'never mind',
  'chalega': 'that works',
  'theek': 'fine',
  'sahi hai': 'that is right',
  'galat hai': 'that is wrong',
  'bahut badhiya': 'excellent',
  'badhiya': 'nice',
  'kamaal': 'amazing',
  'arre wah': 'wow',
  'oho': 'oh',
  'hmm': 'hmm',

  // ── plans / meeting ────────────────────────────────────────────────────────
  'kal milte hai': 'see you tomorrow',
  'aaj milte hai': 'see you today',
  'kal baat karte hai': "let's talk tomorrow",
  'raat ko baat karte hai': "let's talk at night",
  'main nikal raha hoon': 'i am leaving',
  'main pahunch gaya': 'i have arrived',
  'main pahunch gayi': 'i have arrived',
  'pahunch gaye': 'have you arrived',
  'raste me hoon': 'i am on the way',
  'thoda late hoon': 'i am a little late',
  'jaldi aao': 'come quickly',
  'wait karo': 'please wait',
  'intezaar karo': 'please wait',
  'baad me aata hoon': 'i will come later',
  'kal aaunga': 'i will come tomorrow',
  'nahi aa sakta': 'i cannot come',
  'nahi aa sakti': 'i cannot come',

  // ── work / status ──────────────────────────────────────────────────────────
  'kaam kar raha hoon': 'i am working',
  'kaam kar rahi hoon': 'i am working',
  'kaam ho gaya': 'the work is done',
  'kaam baaki hai': 'work is pending',
  'meeting me hoon': 'i am in a meeting',
  'khana kha raha hoon': 'i am eating',
  'so raha hoon': 'i am sleeping',
  'so rahi hoon': 'i am sleeping',
  'uth gaya': 'i am awake',
  'free hoon': 'i am free',
  'thoda busy hoon': 'i am a little busy',
  'baad me batata hoon': 'i will tell you later',

  // ── requests ───────────────────────────────────────────────────────────────
  'photo bhejo': 'send the photo',
  'number bhejo': 'send the number',
  'location bhejo': 'send the location',
  'details bhejo': 'send the details',
  'ek baar dekho': 'please take a look',
  'reply karo': 'please reply',
  'call kar lo': 'please call',
  'batao na': 'please tell me',
  'help karo': 'please help',
  'madad karo': 'please help',
  'confirm karo': 'please confirm',
  'check karo': 'please check',
  'yaad rakhna': 'please remember',
  'bhool mat jana': 'do not forget',

  // ── feelings ───────────────────────────────────────────────────────────────
  'khush hoon': 'i am happy',
  'pareshan hoon': 'i am worried',
  'thak gaya': 'i am tired',
  'thak gayi': 'i am tired',
  'bore ho raha hoon': 'i am bored',
  'miss kar raha hoon': 'i miss you',
  'miss kar rahi hoon': 'i miss you',
  'chinta mat karo': 'do not worry',
  'tension mat lo': 'do not worry',
  'sab theek ho jayega': 'everything will be fine',
  'mubarak ho': 'congratulations',
  'happy birthday': 'happy birthday',

  // ── very common single words ───────────────────────────────────────────────
  'haan bhai': 'yes brother',
  'nahi bhai': 'no brother',
  'bhai': 'brother',
  'didi': 'sister',
  'yaar': 'friend',
  'dost': 'friend',
  'ghar': 'home',
  'office': 'office',
  'paisa': 'money',
  'khana': 'food',
  'pani': 'water',
  'gaadi': 'car',
  'raat': 'night',
  'subah': 'morning',
  'sham': 'evening',
  'parso': 'day after tomorrow',
  'abhi abhi': 'just now',
  'thodi der me': 'in a little while',
  'jaldi': 'quickly',
  'dheere': 'slowly',
  'phir': 'then',
  'lekin': 'but',
  'aur': 'and',
  'ya': 'or',

  // ── added from measured misses (see docs/APP_LANGUAGE_GUIDE.md) ───────────
  'kahan ho tum': 'where are you',
  'khana kha liya': 'have you eaten',
  'khana kha liya kya': 'have you eaten',
  'khana khaya': 'have you eaten',
  'so gaye kya': 'are you asleep',
  'so gaye': 'are you asleep',
  'uth gaye': 'are you awake',
  'thoda late ho jaunga': 'i will be a little late',
  'late ho jaunga': 'i will be late',
  'ghar pahunch gaya': 'i reached home',
  'ghar pahunch gayi': 'i reached home',
  'office me hoon': 'i am at the office',
  'busy hoon abhi': 'i am busy right now',
  'free hoon abhi': 'i am free right now',
  'kyun nahi aaye': 'why did you not come',
  'kyun nahi aayi': 'why did you not come',
  'kitne baje aaoge': 'what time will you come',
  'number bhej do': 'send the number',
  'dekh lo ek baar': 'please take a look',
  'ruko thoda': 'wait a moment',
  'thoda ruko': 'wait a moment',
  'kamaal hai': 'that is amazing',
  'thak gaya hoon': 'i am tired',
  'thak gayi hoon': 'i am tired',
};

/**
 * Words people tack on that carry no meaning for translation.
 *
 * "kaise ho bhai" and "kaise ho" are the same question. Without stripping
 * these, every phrase would need a variant for each filler — "kaise ho bhai",
 * "kaise ho yaar", "kaise ho na"... — which does not scale.
 *
 * Stripping is a SECOND pass: the exact phrase is tried first, so a deliberate
 * entry like "haan bhai" → "yes brother" still wins over the stripped form.
 */
const FILLER_WORDS = new Set([
  'bhai', 'yaar', 'bro', 'ji', 'na', 'naa', 'toh', 'to', 'hi', 'bhi', 're', 'arre', 'ok',
]);

/** Drop leading/trailing filler. Inner words are left alone — "haan na bhai"
 *  loses only the tail, because a filler in the middle can change the phrase. */
function stripFiller(normalized) {
  const words = normalized.split(' ');
  while (words.length > 1 && FILLER_WORDS.has(words[words.length - 1])) words.pop();
  while (words.length > 1 && FILLER_WORDS.has(words[0])) words.shift();
  return words.join(' ');
}

/**
 * Fold a message to the canonical form used as a lookup key.
 *
 * Lowercases, drops trailing punctuation and repeated letters ("nahiii"), and
 * maps each word through the spelling table. Returns '' for anything that is
 * not usable as a key.
 */
export function normalizeHinglish(text) {
  if (typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[?!.,;:]+$/g, '')
    // "nahiii" / "yrrr" — collapse a letter repeated 3+ times down to one.
    .replace(/([a-z])\1{2,}/g, '$1')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => SPELLING_VARIANTS[word] ?? word)
    .join(' ');
}

/**
 * Romanized Hindi → English, or null when this table does not know the phrase.
 *
 * null is the normal case for open-ended chat, and the caller falls through to
 * the cloud fallback. It is not an error.
 */
export function hinglishToEnglish(text) {
  const key = normalizeHinglish(text);
  if (!key) return null;
  // Exact first, so a curated "haan bhai" beats the stripped "haan".
  if (PHRASES[key]) return PHRASES[key];
  const stripped = stripFiller(key);
  if (stripped !== key && PHRASES[stripped]) return PHRASES[stripped];
  return null;
}

/** Exposed so you can report coverage against real message logs. */
export const HINGLISH_PHRASE_COUNT = Object.keys(PHRASES).length;
