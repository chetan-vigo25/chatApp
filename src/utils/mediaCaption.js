/**
 * mediaCaption — ONE rule for "is this media 'caption' actually just the
 * upload's file name?".
 *
 * Media messages carry the picked file's name in `mediaMeta.fileName`, which is
 * what the file bubble, the download/save/share paths and the chat-list preview
 * all read. Historically the send path ALSO copied that name into the message's
 * `text` (the caption field) and shipped it to the server, so every photo and
 * video arrived with a caption like "Screenshot_20260910-101828.jpg" — rendered
 * under the image in the thread, and used as the chat-list preview for group
 * rows. `sendMedia`/`createMediaMessagePayload` no longer do that for images and
 * videos, but two sources of such captions remain and always will:
 *
 *   • messages already stored on the server / in SQLite from older builds, and
 *   • other clients (or the web app) that still send the name as the text.
 *
 * So the render surfaces filter as well as the send path. Both the thread bubble
 * (screens/chats/ChatScreen) and the chat-list preview
 * (contexts/RealtimeChatContext) call in here, so a caption is judged by ONE
 * rule and the two can never disagree about what the same message says.
 *
 * Deliberately conservative: a real caption must keep rendering. A caption is
 * only treated as a file name when it either matches the message's own
 * `mediaMeta.fileName`, or reads like a machine-generated file name — a single
 * token plus a media extension ("IMG_0421.jpg"), or a known device naming
 * pattern ("Screen Shot 2026-09-10 at 1.02.png", "WhatsApp Image 2026-09-10.jpeg").
 * "check this out.jpg" (a real sentence a user typed) still shows.
 *
 * Pure JS — no react-native imports — so it is safe to use from any layer.
 */

// Extensions that mean "this text ends in a file name", not "this is prose".
const FILE_EXT_RE = /\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|avif|mp4|mov|m4v|3gpp?|mkv|avi|webm|mpe?g|mp3|m4a|aac|wav|ogg|oga|opus|amr|flac|pdf|docx?|xlsx?|pptx?|csv|txt|rtf|zip|rar|7z|apk)$/i;

// Device/app naming patterns, for the file names that DO contain spaces.
// Anchored at the start: only the leading token decides.
const DEVICE_NAME_RE = /^(screen[\s_-]?shot|screenshot|img|image|photo|pxl|dsc|dcim|vid|video|movie|whatsapp|signal|telegram|instagram|messenger|fb[\s_-]?img|inshot|snapchat|camera|capture|received|download|downloaded|file|document|doc|scan|scanned|rec|recording|audio|voice|temp|tmp|untitled)\b/i;

/**
 * True when `text` should NOT be shown as a caption because it is only the
 * file's name.
 *
 * @param {string} text            the message's `text` field
 * @param {Object} [mediaMeta]     the message's `mediaMeta` (its `fileName` is
 *                                 an exact match to compare against)
 * @returns {boolean}
 */
export const isFileNameCaption = (text, mediaMeta = null) => {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return false;

  // Exact match against the name this very message carries — the cheap, certain
  // case, and the only one that can catch a name with no recognizable shape.
  const fileName = String(mediaMeta?.fileName || mediaMeta?.name || '').trim();
  if (fileName && trimmed === fileName) return true;

  // No file extension → prose. Leave it alone.
  if (!FILE_EXT_RE.test(trimmed)) return false;

  const base = trimmed.replace(FILE_EXT_RE, '');
  // "IMG_0421", "1757490123456", "Screenshot_20260910-101828" → a file name.
  if (!/\s/.test(base)) return true;
  // Spaces are only a file name when the leading token says so.
  return DEVICE_NAME_RE.test(base);
};

/**
 * The caption to render for a media message — '' when its text is just the file
 * name. Use for the thread bubble, where an empty string means "show no caption".
 *
 * @param {Object} msg  a message row ({ text, mediaMeta })
 * @returns {string}
 */
export const captionOf = (msg) => {
  const text = msg?.text;
  return isFileNameCaption(text, msg?.mediaMeta) ? '' : String(text ?? '');
};

export default { isFileNameCaption, captionOf };
