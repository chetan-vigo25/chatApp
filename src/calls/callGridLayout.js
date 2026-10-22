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
 *   5-8    2 columns x 3-4 rows (an odd last tile stretches its row)
 *   9+     3 columns, up to `max` per page
 *   > max  the surfaces PAGE the rest (swipe left/right), see pageTiles —
 *          a call can hold up to 32 people
 *          (callMachine MAX_PARTICIPANTS), and every one of them gets a tile.
 *
 * The last-row stretch is the whole reason this is a function and not a
 * lookup table: without it an odd participant count leaves a dead black cell
 * in the corner of the grid.
 */

// Tiles per PAGE. A phone shows 8 live videos at a usable size (2 x 4, like
// WhatsApp); the rest sit on the next page. Voice tiles are just avatars, so a
// voice page holds a 3 x 4 grid.
export const MAX_VIDEO_TILES = 8;
export const MAX_VOICE_TILES = 12;

// Percentages are rounded so RN never receives "33.333333333333336%".
const pct = (parts) => `${Math.round((100 / parts) * 10000) / 10000}%`;

const colsFor = (n) => {
  if (n <= 2) return 1;   // 1 = full bleed, 2 = stacked top/bottom
  if (n <= 8) return 2;   // 2x2 / 2x3 / 2x4
  return 3;
};

/** Split the ordered tile list into pages of at most `size` tiles. */
export function pageTiles(list, size) {
  const pages = [];
  for (let i = 0; i < list.length; i += size) pages.push(list.slice(i, i + size));
  return pages.length ? pages : [[]];
}

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

/**
 * Size of the SMALLEST tile a layout produces inside a measured grid box.
 * Stretched last-row tiles are only ever wider, so sizing content to this box
 * guarantees it fits every tile. `gutter` is the cell padding on both sides.
 */
export function tileBox(layout, gridW, gridH, gutter = 0) {
  if (!layout || !gridW || !gridH) return null;
  return {
    width: Math.max(0, gridW / layout.cols - gutter),
    height: Math.max(0, gridH / layout.rows - gutter),
  };
}

/**
 * Largest avatar that fits a tile once `reserve` points of vertical space are
 * kept for the text around it (name / status). The avatar is sized from the
 * tile, never from the participant count alone — a fixed size overflowed short
 * tiles and clipped the avatar and name.
 */
export function fitAvatar(box, reserve, max, min = 28) {
  if (!box) return null;
  const byWidth = box.width * 0.72;
  const byHeight = box.height - reserve;
  return Math.round(Math.max(min, Math.min(max, byWidth, byHeight)));
}

export default gridLayout;
