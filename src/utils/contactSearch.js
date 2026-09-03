/**
 * Advanced contact matching for the "New chat" contact picker.
 *
 * One query box, three identifier kinds: a name, an @username, and a mobile
 * number. A plain `name.includes(q)` missed the last two entirely — a saved
 * contact could not be found by the handle or by a number typed with spaces,
 * dashes or a country code.
 *
 * `buildQuery` parses the raw text once; `contactMatchScore` returns a rank
 * (0 = no match) so the list can be ordered best-match-first instead of
 * alphabetically-first. Both are pure — the same rules run on web and app.
 */

/** Parse the raw input into the three shapes a row can be matched against. */
export function buildQuery(raw) {
  const text = String(raw || '').trim();
  const lower = text.toLowerCase();
  return {
    text,
    lower,
    // "@nikita" and "nikita" are the same lookup.
    handle: lower.replace(/^@+/, ''),
    // "+91 774-247" → "91774247", so formatting never breaks a number match.
    digits: text.replace(/\D/g, ''),
    isEmpty: text.length === 0,
  };
}

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();
const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

/**
 * Rank one row against a parsed query.
 *
 * @param {object} fields { name, names[], username, phones[], extra[] }
 * @param {object} q      from buildQuery()
 * @returns {number} 0 when the row does not match at all; higher = better.
 */
export function contactMatchScore(fields, q) {
  if (!q || q.isEmpty) return 1;
  const names = [fields.name, ...(fields.names || [])].map(norm).filter(Boolean);
  const username = norm(fields.username).replace(/^@+/, '');
  const phones = [...(fields.phones || [])].map(digitsOf).filter(Boolean);
  const extra = (fields.extra || []).map(norm).filter(Boolean);

  let best = 0;
  const bump = (n) => { if (n > best) best = n; };

  // ── Number: only when the query actually carries digits, and matched from
  // the END so a local number finds its +country-code twin (and vice versa).
  if (q.digits.length >= 3) {
    for (const p of phones) {
      if (p === q.digits) bump(100);
      else if (p.endsWith(q.digits) || q.digits.endsWith(p)) bump(85);
      else if (p.includes(q.digits)) bump(70);
    }
  }

  // ── Username (the identifier people share) ──
  if (username && q.handle) {
    if (username === q.handle) bump(95);
    else if (username.startsWith(q.handle)) bump(80);
    else if (username.includes(q.handle)) bump(55);
  }

  // ── Name: a match on a later word ("kumar" → "Rahul Kumar") still counts,
  // just below a match on the first one.
  if (q.lower) {
    for (const n of names) {
      if (n === q.lower) bump(90);
      else if (n.startsWith(q.lower)) bump(75);
      else if (n.split(/\s+/).some((w) => w.startsWith(q.lower))) bump(65);
      else if (n.includes(q.lower)) bump(45);
    }
    for (const e of extra) {
      if (e.includes(q.lower)) bump(20);
    }
  }

  return best;
}

/** Convenience: score > 0. */
export function contactMatches(fields, q) {
  return contactMatchScore(fields, q) > 0;
}

export default { buildQuery, contactMatchScore, contactMatches };
