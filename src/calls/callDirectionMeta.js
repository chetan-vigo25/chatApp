/**
 * WhatsApp call-direction indicator — the single source of truth for the glyph
 * and color that mark a call log entry, shared by the calls list, the call
 * detail screen and the in-thread call bubble.
 *
 * Glyphs are MaterialIcons (the same set WhatsApp Android draws), colored by
 * whether the call actually connected — green when answered, red when not:
 *   outgoing answered      → call-made            (green ↗ with corner)
 *   outgoing not answered  → call-missed-outgoing (red ↗)
 *   incoming answered      → call-received        (green ↙ with corner)
 *   incoming missed/decl.  → call-missed          (red ↙)
 *
 * NOTE: the glyph names below exist in MaterialIcons only. MaterialCommunityIcons
 * has no `call-missed-outgoing`, so rendering these with MCI silently drops the
 * outgoing-missed arrow — that is what this module exists to prevent.
 */
export const CALL_GREEN = '#1DAB61'; // WhatsApp connected-call green
export const CALL_RED = '#F15C6D';   // WhatsApp missed-call red
// Same red, lifted for legibility on the outgoing bubble's dark green ground.
export const CALL_RED_ON_ACCENT = '#FF9BA6';

/** "Connected" = the call actually went through; everything else is a red entry. */
export const isConnectedOutcome = (outcome) => outcome === 'completed';

export const directionMeta = (direction, outcome) => {
  const connected = isConnectedOutcome(outcome);
  if (direction === 'outgoing') {
    return connected
      ? { icon: 'call-made', color: CALL_GREEN }
      : { icon: 'call-missed-outgoing', color: CALL_RED };
  }
  return connected
    ? { icon: 'call-received', color: CALL_GREEN }
    : { icon: 'call-missed', color: CALL_RED };
};

export default directionMeta;
