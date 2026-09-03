import { resolveDisplayName } from '../services/contactNameStore';

/**
 * Render a group system message ("Ravina added Chetan", "User 33 changed the
 * group name to …") from its STRUCTURED event.
 *
 * Why not just print `msg.text`
 * ─────────────────────────────
 * The stored text is frozen at write time from the actor's ACCOUNT name, which
 * is the last resort in our display rule, not the first — and it is the same
 * string for every reader. The rule is per-viewer:
 *   saved contact name → their number → "@handle" when they hide their contact
 *   → their account name.
 * A member who later turns `hideContact` on would also stay named by that old
 * string forever, which is exactly what the toggle is supposed to prevent.
 *
 * So the server also sends `message.systemEvent` and we build the sentence here
 * with the same resolver every other surface uses. The templates mirror
 * chat-backend/src/services/groupSystemEvent.js and
 * chat-website/src/utils/systemMessage.js — change one, change all three.
 */

const idOf = (v) => (v == null ? '' : String(v?._id || v?.userId || v));

const joinNames = (names) => {
  const list = (names || []).filter(Boolean);
  if (!list.length) return 'a member';
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
};

/**
 * Label one participant of the sentence.
 * `selfId` gets "You" — WhatsApp names the reader in the second person.
 */
const labelFor = (event, userId, selfId) => {
  const id = idOf(userId);
  if (!id) return 'A member';
  if (selfId && id === String(selfId)) return 'You';
  // The event carries a redacted identity snapshot for everyone it names, so a
  // member who has since LEFT the group still resolves — no lookup needed, and
  // a hidden user's number was never written into it in the first place.
  const snap = (event?.users || []).find((u) => idOf(u.userId) === id) || {};
  return resolveDisplayName({
    userId: id,
    phone: snap.mobileNumber || null,
    pushName: snap.pushName || null,
    username: snap.userName || null,
    hideContact: Boolean(snap.hideContact),
    fallback: 'A member',
  });
};

/**
 * @param {object} message  the message row (needs `systemEvent`, falls back to `text`)
 * @param {string} selfId   the viewing user's id, so they read as "You"
 * @returns {string} the sentence to render
 */
export const renderSystemMessage = (message, selfId = null) => {
  const event = message?.systemEvent;
  const fallback = message?.text || message?.content || '';
  if (!event?.type) return fallback;

  const actor = () => labelFor(event, event.actorId, selfId);
  const targets = () => joinNames((event.targetIds || []).map((id) => labelFor(event, id, selfId)));
  // "You is now an admin" — the second person needs the verb to agree.
  const targetIsSelf = (event.targetIds || []).length === 1
    && selfId && idOf(event.targetIds[0]) === String(selfId);
  const is = targetIsSelf ? 'are' : 'is';

  switch (event.type) {
    case 'group_created': return `${actor()} created the group`;
    case 'members_added': return `${actor()} added ${targets()}`;
    case 'member_removed': return `${actor()} removed ${targets()}`;
    case 'member_left': return `${actor()} left`;
    case 'admin_promoted': return `${targets()} ${is} now an admin`;
    case 'admin_demoted': return `${targets()} ${is} no longer an admin`;
    case 'owner_changed': return `${targets()} ${is} now the group owner`;
    case 'group_name_changed':
      return event.value
        ? `${actor()} changed the group name to "${event.value}"`
        : `${actor()} changed the group name`;
    case 'group_icon_changed': return `${actor()} changed this group's icon`;
    case 'group_description_changed': return `${actor()} changed the group description`;
    case 'group_settings_changed': return `${actor()} changed the group settings`;
    // An event type this build doesn't know yet — the server's own rendering of
    // it is already in `text`, so show that rather than nothing.
    default: return fallback;
  }
};

export default { renderSystemMessage };
