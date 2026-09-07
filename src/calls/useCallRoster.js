import { useEffect, useState } from 'react';
import useContactDirectory from '../hooks/useContactDirectory';
import ChatDatabase from '../services/ChatDatabase';

/**
 * useCallRoster — resolves a raw call roster into DISPLAY-READY participants.
 *
 * The socket roster only carries ids (names arrive as the placeholder "Member"),
 * so every call surface that lists people has to run the same resolution:
 *
 *   saved contact name  >  their "@handle" (if they hide their number)
 *   >  mobile number  >  whatever name the backend sent
 *
 * This used to live inline in CallOverlay, which meant the VIDEO tile grid
 * (rendered further down the tree, in NativeVideoStage) had no way to reach it
 * and would have labelled its tiles "Member". Both surfaces now share this hook,
 * so a conference shows the same names whether it is on voice or video.
 *
 * @param {object}  participants  raw roster map ({ [id]: { id, name, mobile, avatar, joined, left } })
 * @param {object}  opts
 * @param {boolean} opts.connectedOnly  drop anyone who has not joined yet — used
 *   by the RECEIVER once answered, so they never see "Connecting…" ghosts for
 *   members who never picked up.
 * @returns {object} the same map shape, with `name` resolved.
 */
export default function useCallRoster(participants, { connectedOnly = false } = {}) {
  const { resolveName, peerPrivacyOf } = useContactDirectory();

  // Local identity fallback for roster entries that arrived as bare ids
  // ("Member"): the 1:1 chat row for that peer already stores their name /
  // number exactly as the chat list shows them. Looked up once per id;
  // null-cached so a missing chat doesn't re-query every render.
  const [peerIdentityMap, setPeerIdentityMap] = useState({});

  useEffect(() => {
    const all = Object.values(participants || {});
    const missing = all.filter((p) => p?.id
      && (!p.name || p.name === 'Member' || p.name === 'Unknown')
      && !p.mobile
      && peerIdentityMap[p.id] === undefined);
    if (!missing.length) return undefined;
    let alive = true;
    (async () => {
      const updates = {};
      for (const p of missing) {
        updates[p.id] = await ChatDatabase.getPeerIdentity(p.id).catch(() => null);
      }
      if (alive) setPeerIdentityMap((prev) => ({ ...prev, ...updates }));
    })();
    return () => { alive = false; };
  }, [participants, peerIdentityMap]);

  const out = {};
  Object.values(participants || {}).forEach((p) => {
    if (!p || !p.id) return;
    if (connectedOnly && !p.joined) return;
    // Product rule: saved contact -> the locally saved name; unsaved -> their
    // mobile number; NEVER the bare "Member" label when we know anything
    // better. Number sources, in order: roster mobile (backend identity),
    // then the local 1:1 chat row for this peer (peerIdentityMap). resolveName
    // already prefers saved name > phone > fallback.
    const ident = peerIdentityMap[p.id] || null;
    // Identity fields can arrive as a { code, number } mobile OBJECT from
    // older payloads/cached rows — coerce everything to a string here so the
    // tile label can never render "[object Object]".
    const asText = (v) => {
      if (!v) return null;
      if (typeof v === 'string') return v.trim() || null;
      if (typeof v === 'object') return `${v.code || ''}${v.number || ''}`.trim() || null;
      return String(v);
    };
    const pName = asText(p.name);
    const genericName = !pName || pName === 'Member' || pName === 'Unknown';
    const fallbackName = genericName
      ? (asText(ident?.fullName) || asText(ident?.mobileNumber) || pName)
      : pName;
    const phone = asText(p.mobile) || asText(p.phone) || asText(ident?.mobileNumber) || null;
    // Merge both identity sources before reading the privacy bits: the roster
    // carries `hideContact` + `userName`, while the local chat row (`ident`)
    // may only have one of them.
    const rosterPrivacy = peerPrivacyOf(p);
    const identPrivacy = peerPrivacyOf(ident);
    const privacy = {
      // Prefer whichever source actually HAS the value — a plain spread let a
      // null from the roster wipe a handle the chat row knew about.
      username: rosterPrivacy.username || identPrivacy.username,
      hideContact: rosterPrivacy.hideContact || identPrivacy.hideContact,
    };
    const name = resolveName(p.id, fallbackName, phone, privacy) || fallbackName || 'Member';
    out[p.id] = name === p.name ? p : { ...p, name };
  });
  return out;
}
