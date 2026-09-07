/**
 * Shared tile geometry for the GROUP / CONFERENCE call grid.
 *
 * ONE source of truth for both call surfaces, so a voice conference and a video
 * conference are laid out identically (a voice tile is just a video tile whose
 * camera is off — same box, avatar instead of an RTCView):
 *
 *   • NativeVideoStage  — the live <RTCView> tiles (video calls)
 *   • CallParticipantsGrid — the avatar roster tiles (voice calls, and the
 *     ringing/ended states of a video call, where no media exists yet)
 *
 * Layout rules (tile count INCLUDES your own "You" tile):
 *
 *   1      one full-bleed tile
 *   2      stacked full-width halves — one on top, one below
 *   3      2x2 where the odd last tile STRETCHES to the full row width
 *   4      clean 2x2
 *   5-6    2 columns x 3 rows (a 5th tile stretches its last row)
 *   7+     3 columns, up to `max`
 *   > max  truncated, and the caller draws a "+N" chip on the last tile
 *
 * The last-row stretch is the whole reason this is a function and not a
 * lookup table: without it an odd participant count leaves a dead black cell
 * in the corner of the grid.
 */

// Beyond ~6 live video tiles a phone cannot render anything useful, so video
// stops here and shows "+N". Voice tiles are just avatars (no decode cost), so
// the roster passes a higher ceiling.
export const MAX_VIDEO_TILES = 6;
export const MAX_VOICE_TILES = 9;

// Percentages are rounded so RN never receives "33.333333333333336%".
const pct = (parts) => `${Math.round((100 / parts) * 10000) / 10000}%`;

const colsFor = (n) => {
  if (n <= 2) return 1;   // 1 = full bleed, 2 = stacked top/bottom
  if (n <= 6) return 2;   // 2x2 / 2x3
  return 3;
};

/**
 * @param {number} count  total participants to place (self included)
 * @param {number} max    hard ceiling; the overflow is reported as `extra`
 * @returns {{ count:number, extra:number, cols:number, rows:number,
 *             tileStyle:(i:number)=>{width:string,height:string},
 *             isLast:(i:number)=>boolean }}
 */
export function gridLayout(count, max = MAX_VIDEO_TILES) {
  const shown = Math.max(0, Math.min(count, max));
  const extra = Math.max(0, count - shown);
  const cols = colsFor(shown);
  const rows = Math.max(1, Math.ceil(shown / cols));
  // How many tiles actually sit in the final row — 0 would mean the last row is
  // full, so normalise it back to a whole row.
  const inLastRow = shown - (rows - 1) * cols || cols;

  const tileStyle = (i) => {
    const onLastRow = Math.floor(i / cols) === rows - 1;
    // A short last row spreads its tiles across the full width instead of
    // leaving an empty cell (the "3 people = visible hole" bug).
    const span = onLastRow && inLastRow < cols ? inLastRow : cols;
    return { width: pct(span), height: pct(rows) };
  };

  return {
    count: shown,
    extra,
    cols,
    rows,
    tileStyle,
    isLast: (i) => i === shown - 1,
  };
}

export default gridLayout;
