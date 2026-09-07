/**
 * Device media library access for the in-app gallery grid (components/AttachmentSheet).
 *
 * The system picker (contexts/ImageProvider) stays exactly as it was — this
 * module is the *other* source of the same file shape. Everything here returns
 * the `{ uri, name, type, size, width, height, duration }` object that
 * useChatLogic's sendMedia / sendMediaGroup already consume, so an in-sheet
 * pick and a system-picker pick travel the identical upload/socket path.
 *
 * FileSystem is imported from `expo-file-system/legacy` deliberately: SDK 54
 * moved the classic API there, and the new default export THROWS on
 * downloadAsync/getInfoAsync (see expo-file-system/src/legacyWarnings.ts).
 * Every other module in this app imports the legacy entry point for the same
 * reason.
 */
import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library';

/** One screenful and a bit — the grid pages in as the user scrolls. */
export const MEDIA_PAGE_SIZE = 48;

/**
 * How much of the head to re-read when the library reports a change.
 * A capture adds one item; a screenshot burst or a chat download adds a
 * handful. Re-reading a couple of rows is enough to find them and costs a
 * fraction of a full reload, which is the whole point of the observer.
 */
export const MEDIA_HEAD_PAGE_SIZE = 24;

/** Seconds → "0:42" / "1:05:03". The grid renders this string verbatim. */
export const formatMediaDuration = (seconds) => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
};

const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
};

const mimeForName = (name, isVideo) => {
  const ext = String(name || '').split('.').pop()?.toLowerCase();
  return EXT_MIME[ext] || (isVideo ? 'video/mp4' : 'image/jpeg');
};

const isVideoAsset = (asset) => (
  asset?.mediaType === MediaLibrary.MediaType.video || asset?.mediaType === 'video'
);

/**
 * One MediaLibrary asset → the app's file shape.
 *
 * iOS hands back `ph://` identifiers that no uploader can read, so the real
 * path always comes from getAssetInfoAsync().localUri. Android already gives a
 * `file://` path for the common case; a `content://` one is copied into the
 * cache the same way ImageProvider does it for picker assets.
 *
 * `size` is intentionally left at 0 when the OS does not volunteer it —
 * useChatLogic's prepare step re-reads it from disk after compression anyway
 * (see the "Refresh size from disk" block), so guessing here would only be
 * overwritten.
 *
 * @returns {Promise<Object|null>} null when the asset cannot be resolved; the
 *          caller drops it rather than sending a broken uri.
 */
export const normalizeLibraryAsset = async (asset) => {
  if (!asset?.id && !asset?.uri) return null;

  const video = isVideoAsset(asset);
  const name = asset.filename || `media_${asset.id || Date.now()}.${video ? 'mp4' : 'jpg'}`;
  let uri = asset.uri;
  let width = Number(asset.width) || undefined;
  let height = Number(asset.height) || undefined;
  const duration = Number(asset.duration) || undefined;

  // iOS never has a usable uri on the asset itself; Android does unless the
  // asset lives behind a content provider.
  if (asset.id && (Platform.OS === 'ios' || !uri || uri.startsWith('content://'))) {
    try {
      const info = await MediaLibrary.getAssetInfoAsync(asset.id);
      if (info?.localUri) uri = info.localUri;
      if (!width && info?.width) width = Number(info.width);
      if (!height && info?.height) height = Number(info.height);
    } catch (err) {
      console.warn('[deviceMedia] getAssetInfoAsync failed', err?.message || err);
    }
  }

  if (!uri) return null;

  if (Platform.OS === 'android' && uri.startsWith('content://')) {
    try {
      const dest = `${FileSystem.cacheDirectory}${Date.now()}_${name}`;
      const copied = await FileSystem.downloadAsync(uri, dest);
      if (copied?.uri) uri = copied.uri;
    } catch (err) {
      console.warn('[deviceMedia] content:// copy failed, using original', err?.message || err);
    }
  }

  // A ph:// that survived the lookup above is unreadable by the uploader —
  // dropping it beats queueing a send that can only fail.
  if (uri.startsWith('ph://')) return null;

  return {
    uri,
    name,
    type: mimeForName(name, video),
    size: 0,
    width,
    height,
    duration,
  };
};

/** Normalize a selection, preserving the order the user tapped them in. */
export const normalizeLibraryAssets = async (assets) => {
  const files = [];
  for (const asset of assets) {
    const file = await normalizeLibraryAsset(asset);
    if (file) files.push(file);
  }
  return files;
};

/**
 * Sort variants, tried in order until one works, then remembered.
 *
 * `creationTime` is NOT the default even though it reads like the obvious
 * choice. It maps to MediaStore's DATE_TAKEN, which:
 *   • is NULL for everything that did not come from a camera — screenshots,
 *     downloads, media saved by other chat apps — so those sort into a clump
 *     rather than into the timeline; and
 *   • is queried here against the *Files* collection, which some MediaStore
 *     implementations reject as a sort column outright, failing the whole
 *     query. getAlbumsAsync survives that because it sorts by
 *     BUCKET_DISPLAY_NAME, which is why albums can list while assets come back
 *     empty.
 * DATE_MODIFIED is always populated and always sortable, and for a camera roll
 * it orders the same way a user expects "newest first" to.
 */
const SORT_VARIANTS = [
  [[MediaLibrary.SortBy.modificationTime, false]],
  [[MediaLibrary.SortBy.creationTime, false]],
  undefined, // the module's own default ordering — always accepted
];

// Pagination cursors are positions within one ordering, so once a variant has
// worked every later page must use that same one.
let activeSortVariant = null;

const queryAssets = (opts, sortBy) => MediaLibrary.getAssetsAsync({
  first: opts.first,
  after: opts.after || undefined,
  album: opts.albumId || undefined,
  mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
  ...(sortBy ? { sortBy } : {}),
});

/**
 * One page of the camera roll, newest first.
 *
 * Rejects only when EVERY sort variant fails — the caller shows that message
 * rather than an empty grid, because "no photos" and "the query blew up" look
 * identical to a user and only one of them is their fault.
 *
 * @param {Object}  [opts]
 * @param {string}  [opts.after]  endCursor of the previous page
 * @param {string}  [opts.albumId] restrict to one album (undefined = Recents)
 * @returns {Promise<{assets: Object[], endCursor: string|null, hasNextPage: boolean}>}
 */
export const loadDeviceMedia = async (opts = {}) => {
  const { first = MEDIA_PAGE_SIZE } = opts;
  const options = { ...opts, first };
  const isFirstPage = !opts.after;

  // Later pages must not re-negotiate the ordering.
  if (activeSortVariant !== null && !isFirstPage) {
    const page = await queryAssets(options, SORT_VARIANTS[activeSortVariant]);
    return {
      assets: page?.assets || [],
      endCursor: page?.endCursor || null,
      hasNextPage: Boolean(page?.hasNextPage),
    };
  }

  const order = activeSortVariant !== null
    ? [activeSortVariant, ...SORT_VARIANTS.keys()].filter((v, i, a) => a.indexOf(v) === i)
    : [...SORT_VARIANTS.keys()];

  let lastError = null;
  let lastEmpty = null;

  for (const index of order) {
    try {
      const page = await queryAssets(options, SORT_VARIANTS[index]);
      const assets = page?.assets || [];
      const result = {
        assets,
        endCursor: page?.endCursor || null,
        hasNextPage: Boolean(page?.hasNextPage),
      };
      if (assets.length > 0) {
        activeSortVariant = index;
        return result;
      }
      // A variant that succeeds but returns nothing is kept as the answer only
      // if no other variant does better: an unsupported sort can come back
      // empty instead of throwing.
      lastEmpty = result;
    } catch (err) {
      console.warn(`[deviceMedia] asset query variant ${index} failed`, err?.message || err);
      lastError = err;
    }
  }

  if (lastEmpty) {
    activeSortVariant = activeSortVariant ?? SORT_VARIANTS.length - 1;
    return lastEmpty;
  }
  throw lastError || new Error('Could not read the media library.');
};

/**
 * Albums for the "Recents ▾" dropdown, biggest first, empties dropped.
 * Never rejects — an album list is a convenience, not a precondition for the
 * grid, so a failure just leaves the user on Recents.
 */
export const loadDeviceAlbums = async () => {
  try {
    const albums = await MediaLibrary.getAlbumsAsync({ includeSmartAlbums: true });
    return (albums || [])
      .filter((a) => Number(a.assetCount) > 0)
      .sort((a, b) => Number(b.assetCount) - Number(a.assetCount))
      .map((a) => ({ id: a.id, title: a.title, count: Number(a.assetCount) || 0 }));
  } catch (err) {
    console.warn('[deviceMedia] album list failed', err?.message || err);
    return [];
  }
};
