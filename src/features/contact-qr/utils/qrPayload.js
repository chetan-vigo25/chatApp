/**
 * What goes INTO a contact QR, and how a scanned string is classified.
 *
 * The code carries only an opaque server token — never a userId, name or
 * number. Anything in the QR can be forged, screenshotted and shared forever,
 * so the server resolves the token and applies privacy + block rules
 * (docs/CONTACT_QR_SERVER_SPEC.md).
 */

export const CONTACT_QR_SCHEME_PREFIX = 'talkstry://u/';

const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/;

export const buildContactQrValue = (token) => `${CONTACT_QR_SCHEME_PREFIX}${token}`;

/**
 * @returns {{ kind: 'contact', token: string }
 *         | { kind: 'device-link' }
 *         | { kind: 'unknown' }}
 */
export function parseScannedQr(raw) {
  const text = String(raw || '').trim();

  // talkstry://u/<token>, or a hosted https://<host>/u/<token> link — accepted
  // now so the server can move to universal links without an app update.
  const match =
    text.match(/^talkstry:\/\/u\/([^/?#\s]+)/i) ||
    text.match(/^https?:\/\/[^/\s]+\/u\/([^/?#\s]+)/i);
  if (match && TOKEN_RE.test(match[1])) {
    return { kind: 'contact', token: match[1] };
  }

  // The web client's device-linking QR is JSON { sessionId, publicKey } —
  // recognise it so the user is pointed at "Linked devices" instead of a
  // generic "invalid code".
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed?.sessionId && parsed?.publicKey) return { kind: 'device-link' };
    } catch { /* not JSON */ }
  }

  return { kind: 'unknown' };
}
