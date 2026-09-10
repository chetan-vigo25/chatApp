/**
 * @mention plumbing, shared by every path a message travels.
 *
 * A mention is stored as `{ userId, displayName }`, where `displayName` is the
 * label the SENDER typed, always WITHOUT a leading "@" (MentionInput
 * normalizes it there). The literal `@` + displayName token inside `text` is
 * the anchor; what each viewer actually SEES is re-resolved from their own
 * address book at render time, so the same message reads "@Priyansh" for one
 * person and "@~Brijesh" for another.
 *
 * The metadata is what makes highlighting possible, so it has to survive every
 * hop: composer → socket → the global ingest → the SQLite payload column →
 * reload. It only takes one hop dropping the array for a mention to render as
 * flat text on the receiving side.
 */

/**
 * Pull mentions off ANY message shape and clean them into the canonical form.
 * Transports disagree on where the array lives (top level, inside `payload`,
 * or under `mentionedUsers`) and on what the id field is called.
 *
 * `displayName` is preserved VERBATIM: it is matched against the literal text
 * of the message, so rewriting it here — trimming a leading "@", say — would
 * stop older messages from matching their own text.
 */
export const normalizeMentions = (source) => {
  if (!source) return null;
  const raw = Array.isArray(source) ? source
    : (Array.isArray(source?.mentions) ? source.mentions
      : (Array.isArray(source?.payload?.mentions) ? source.payload.mentions
        : (Array.isArray(source?.mentionedUsers) ? source.mentionedUsers : null)));
  if (!raw || raw.length === 0) return null;

  const cleaned = [];
  const seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    const displayName = m.displayName || m.fullName || m.name || null;
    if (!displayName) continue;
    const userId = m.userId != null ? String(m.userId)
      : (m._id != null ? String(m._id) : (m.id != null ? String(m.id) : null));
    // Same person mentioned twice in one message is one entry — the scanner
    // below highlights every occurrence of the token regardless.
    const key = `${userId || ''}::${displayName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cleaned.push({
      userId,
      displayName,
      startIndex: Number.isFinite(Number(m.startIndex)) ? Number(m.startIndex) : null,
      length: Number.isFinite(Number(m.length)) ? Number(m.length) : null,
    });
  }
  return cleaned.length > 0 ? cleaned : null;
};

/** Where a stored message keeps its mentions, whichever writer put them there. */
export const mentionsOf = (msg) => normalizeMentions(msg);

const isWordChar = (ch) => Boolean(ch) && /[\p{L}\p{N}_]/u.test(ch);

/**
 * Last-resort reconstruction for rows that reached this device WITHOUT their
 * mention metadata — messages stored before the ingest carried it, or a server
 * that does not echo the array back.
 *
 * It only ever proposes a member of THIS conversation whose name appears in the
 * text behind an "@", so it cannot invent a mention: the worst case is a miss
 * (the sender's label for someone differs from this viewer's), never a wrong
 * name on the wrong person.
 */
export const inferMentionsFromText = (text, membersMap) => {
  if (!text || !text.includes('@') || !membersMap) return null;
  const ownerByLabel = new Map();
  for (const [userId, member] of Object.entries(membersMap)) {
    for (const name of [member?.fullName, member?.userName, member?.name]) {
      const label = String(name || '').replace(/^@+/, '').trim();
      if (label && !ownerByLabel.has(label)) ownerByLabel.set(label, String(userId));
    }
  }
  if (ownerByLabel.size === 0) return null;

  const hits = scanMentionTokens(text, [...ownerByLabel.keys()]);
  if (hits.length === 0) return null;
  return normalizeMentions(hits.map((h) => ({
    userId: ownerByLabel.get(h.name),
    displayName: h.name,
  })));
};

/**
 * Every position in `text` where one of `names` appears as an "@" token.
 *
 * Both edges are guarded:
 *  • Longest name first, and the character AFTER a match must not be a word
 *    character — so a member called "Ram" does not light up the first three
 *    letters of a message addressed to "@Ramesh".
 *  • The character BEFORE the "@" must not be a word character either, so the
 *    "@Ram" inside the email address "a@Ram.com" is left alone.
 */
const scanMentionTokens = (text, names) => {
  const sorted = [...new Set(names.filter(Boolean))].sort((a, b) => b.length - a.length);
  const hits = [];
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf('@', i);
    if (at === -1) break;
    let matched = null;
    if (at === 0 || !isWordChar(text[at - 1])) {
      for (const name of sorted) {
        const end = at + 1 + name.length;
        if (text.slice(at + 1, end) === name && !isWordChar(text[end])) {
          matched = { start: at, end, name };
          break;
        }
      }
    }
    if (matched) {
      hits.push(matched);
      i = matched.end;
    } else {
      i = at + 1;
    }
  }
  return hits;
};

/**
 * Split `text` into the runs that should be styled and the runs that should
 * not. ONLY the "@name" token itself comes back as a mention segment — the rest
 * of the message stays plain, which is the whole point: "@User Ballu hi" is one
 * highlighted token followed by an ordinary " hi".
 *
 * Returns [{ type: 'text' | 'mention', content, userId?, displayName? }].
 * A message with no resolvable mention yields a single text segment, so callers
 * can render the result unconditionally.
 */
export const splitTextOnMentions = (text, mentions) => {
  const str = typeof text === 'string' ? text : '';
  if (!str) return [];
  const list = Array.isArray(mentions) ? mentions.filter((m) => m?.displayName) : [];
  if (list.length === 0) return [{ type: 'text', content: str }];

  const byName = new Map();
  for (const m of list) {
    const label = String(m.displayName);
    // First wins: two members sharing a label is ambiguous, and picking the
    // earlier of the two is at least stable across renders.
    if (!byName.has(label)) byName.set(label, m);
  }

  const hits = scanMentionTokens(str, [...byName.keys()]);
  if (hits.length === 0) return [{ type: 'text', content: str }];

  const segments = [];
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start > cursor) segments.push({ type: 'text', content: str.slice(cursor, hit.start) });
    const mention = byName.get(hit.name);
    segments.push({
      type: 'mention',
      content: str.slice(hit.start, hit.end),
      userId: mention?.userId || null,
      displayName: mention?.displayName || hit.name,
    });
    cursor = hit.end;
  }
  if (cursor < str.length) segments.push({ type: 'text', content: str.slice(cursor) });
  return segments;
};

export default {
  normalizeMentions,
  mentionsOf,
  inferMentionsFromText,
  splitTextOnMentions,
};
