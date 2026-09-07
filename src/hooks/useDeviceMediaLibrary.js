/**
 * The camera roll as a paged, self-refreshing list — with no UI in it.
 *
 * Everything the media grid needs to *get* pictures lives here: permission
 * state, cursor pagination, the native change observer, and foreground
 * refresh. components/AttachmentSheet only renders what this returns, so the
 * fetching policy can change without touching a single style.
 *
 * The three rules that keep it smooth:
 *
 *  1. NOTHING runs while the sheet is animating. The first page is scheduled
 *     through InteractionManager, so the spring finishes on an idle JS thread
 *     and the grid fills in a frame or two later. Opening never waits on the
 *     library.
 *  2. Pages are small and cursor-based (MEDIA_PAGE_SIZE at a time). The full
 *     gallery is never read — a 10k-photo roll costs exactly the same to open
 *     as a 100-photo one.
 *  3. A library change re-reads only the HEAD of the list, diffs it against the
 *     ids already held, and prepends what is genuinely new. Taking a new photo
 *     does not re-fetch, re-sort, or re-render the roll behind it.
 *
 * Asset objects are the OS's own lightweight records — id, uri, dimensions,
 * duration. No bytes, no Base64, no resolved originals: those are read one at a
 * time, at send, by utils/deviceMedia.normalizeLibraryAsset.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, InteractionManager, PermissionsAndroid, Platform } from 'react-native';
import * as MediaLibrary from 'expo-media-library';

import { ensurePermission, PERMISSION_IDS } from '../features/permissions/ensurePermission';
import permissionManager from '../features/permissions/data/PermissionManager';
import {
  MEDIA_HEAD_PAGE_SIZE,
  MEDIA_PAGE_SIZE,
  loadDeviceAlbums,
  loadDeviceMedia,
} from '../utils/deviceMedia';

/** MediaStore fires several times for one save (insert, then scan). */
const CHANGE_DEBOUNCE_MS = 400;

/**
 * @param {Object}  options
 * @param {boolean} options.enabled  false while the sheet is closed — no
 *                                   listeners, no queries, no work at all
 */
export default function useDeviceMediaLibrary({ enabled }) {
  const [assets, setAssets] = useState([]);
  const [permissionGranted, setPermissionGranted] = useState(null); // null = unknown
  const [accessPrivileges, setAccessPrivileges] = useState(null);   // 'all' | 'limited' | 'none'
  const [hasNextPage, setHasNextPage] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [albums, setAlbums] = useState(null);   // null = not fetched yet
  const [album, setAlbum] = useState(null);     // null = Recents

  // Refs, not state: these drive fetching and must never cause a render.
  const cursorRef = useRef(null);
  const idsRef = useRef(new Set());
  const inFlightRef = useRef(false);
  const aliveRef = useRef(true);
  const manifestMissingPhotosRef = useRef(false);
  const permissionSignatureRef = useRef('');

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  // ── Permission ────────────────────────────────────────────────────────────

  /**
   * Ask ANDROID what the visual-media grant really is.
   *
   * expo-media-library's `accessPrivileges` cannot be trusted to mean what it
   * says. It reports ALL only when EVERY permission in the requested set came
   * back granted — and that set includes ACCESS_MEDIA_LOCATION (declared in
   * this app's manifest), plus READ_MEDIA_AUDIO on an unscoped call. Miss any
   * one of those and it falls through to a check of
   * READ_MEDIA_VISUAL_USER_SELECTED alone, which Android 14+ grants whenever
   * visual access is granted AT ALL — "Allow all" included. So full photo
   * access with, say, ACCESS_MEDIA_LOCATION denied is reported as `limited`,
   * and the picker would show a "Allow all photos" prompt to a user who had
   * already allowed all photos.
   *
   * READ_MEDIA_IMAGES / READ_MEDIA_VIDEO are the only honest signal: either is
   * granted → the app can see the whole library, full stop.
   */
  const readAndroidVisualAccess = useCallback(async () => {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33) return null;
    try {
      const [images, video, userSelected] = await Promise.all([
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES),
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO),
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.READ_MEDIA_VISUAL_USER_SELECTED),
      ]);
      if (images || video) return 'all';
      if (userSelected) return 'limited';
      return 'none';
    } catch (err) {
      console.warn('[mediaLibrary] direct permission check failed', err?.message || err);
      return null;
    }
  }, []);

  // Scoped to photo+video: the unscoped call also checks READ_MEDIA_AUDIO on
  // Android 13+, so an app holding exactly the permissions this grid needs
  // would be reported as denied.
  //
  // Falls back to the unscoped call rather than failing, because the scoped
  // form throws outright when a granular permission is missing from the
  // manifest — a stale install must still show whatever it CAN read.
  const readPermission = useCallback(async () => {
    if (Platform.OS !== 'android') return MediaLibrary.getPermissionsAsync();

    let status;
    try {
      status = await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
      manifestMissingPhotosRef.current = false;
    } catch (err) {
      manifestMissingPhotosRef.current = /manifest/i.test(String(err?.message || ''));
      console.warn('[mediaLibrary] scoped permission check failed', err?.message || err);
      status = await MediaLibrary.getPermissionsAsync();
    }

    // Android's own answer wins over expo's summary — see the note above.
    const actual = await readAndroidVisualAccess();
    if (!actual) return status;
    return {
      ...status,
      granted: actual !== 'none' ? true : Boolean(status?.granted),
      accessPrivileges: actual,
    };
  }, [readAndroidVisualAccess]);

  // ── Fetching ──────────────────────────────────────────────────────────────

  /** Replace everything. Only for a real context switch: album, or a widened grant. */
  const reload = useCallback(async (albumId) => {
    inFlightRef.current = true;
    setLoading(true);
    setError(null);
    cursorRef.current = null;
    idsRef.current = new Set();
    try {
      const page = await loadDeviceMedia({ albumId, first: MEDIA_PAGE_SIZE });
      if (!aliveRef.current) return;
      for (const asset of page.assets) idsRef.current.add(asset.id);
      cursorRef.current = page.endCursor;
      setAssets(page.assets);
      setHasNextPage(page.hasNextPage);
    } catch (err) {
      console.warn('[mediaLibrary] reload failed', err?.message || err);
      if (!aliveRef.current) return;
      setAssets([]);
      setHasNextPage(false);
      setError(err?.message || 'Could not read your media library.');
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setLoading(false);
    }
  }, []);

  /** Next page. Safe to call on every onEndReached — it self-guards. */
  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasNextPage || !cursorRef.current || !permissionGranted) return;
    inFlightRef.current = true;
    setLoading(true);
    try {
      const page = await loadDeviceMedia({
        after: cursorRef.current,
        albumId: album?.id,
        first: MEDIA_PAGE_SIZE,
      });
      if (!aliveRef.current) return;
      const fresh = page.assets.filter((asset) => !idsRef.current.has(asset.id));
      for (const asset of fresh) idsRef.current.add(asset.id);
      cursorRef.current = page.endCursor;
      setHasNextPage(page.hasNextPage);
      // No new ids means no state write, so no re-render of the grid.
      if (fresh.length) setAssets((prev) => [...prev, ...fresh]);
    } catch (err) {
      console.warn('[mediaLibrary] page failed', err?.message || err);
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) setLoading(false);
    }
  }, [album?.id, hasNextPage, permissionGranted]);

  /**
   * Read just the head of the list and prepend what we have not seen.
   *
   * This is the whole point of the observer: a new capture costs one small
   * query and a splice, never a reload. `setAssets` is skipped entirely when
   * nothing is new, so a spurious MediaStore notification renders nothing.
   */
  const refreshLatest = useCallback(async () => {
    if (inFlightRef.current || !permissionGranted) return;
    inFlightRef.current = true;
    try {
      const page = await loadDeviceMedia({ albumId: album?.id, first: MEDIA_HEAD_PAGE_SIZE });
      if (!aliveRef.current) return;
      const fresh = page.assets.filter((asset) => !idsRef.current.has(asset.id));
      if (!fresh.length) return;
      for (const asset of fresh) idsRef.current.add(asset.id);

      // Android's endCursor is an OFFSET into the query, so rows inserted at
      // the head shift every later page down by that many. Advancing it keeps
      // pagination aligned instead of re-serving rows we already hold.
      const offset = Number(cursorRef.current);
      if (Number.isFinite(offset)) cursorRef.current = String(offset + fresh.length);

      setAssets((prev) => [...fresh, ...prev]);
    } catch (err) {
      console.warn('[mediaLibrary] head refresh failed', err?.message || err);
    } finally {
      inFlightRef.current = false;
    }
  }, [album?.id, permissionGranted]);

  /**
   * Re-read the grant and act on what changed. A widened (or narrowed) grant
   * changes which assets exist and needs a reload; an unchanged one only needs
   * the head, which is the common case when returning from the camera.
   */
  const syncPermission = useCallback(async ({ initial = false } = {}) => {
    let status;
    try {
      status = await readPermission();
    } catch {
      if (aliveRef.current) setPermissionGranted(false);
      return;
    }
    if (!aliveRef.current) return;

    const granted = Boolean(status?.granted) || status?.accessPrivileges === 'limited';
    const signature = `${granted}:${status?.accessPrivileges || ''}`;
    const changed = signature !== permissionSignatureRef.current;
    permissionSignatureRef.current = signature;

    setPermissionGranted(granted);
    setAccessPrivileges(status?.accessPrivileges || null);
    if (!granted) return;

    if (initial || changed) reload(album?.id);
    else refreshLatest();
  }, [readPermission, reload, refreshLatest, album?.id]);

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  // First load, deferred past the open animation. The sheet is already on
  // screen and interactive by the time this runs; nothing here can drop a
  // frame of the spring.
  useEffect(() => {
    if (!enabled) return undefined;
    const task = InteractionManager.runAfterInteractions(() => {
      syncPermission({ initial: permissionSignatureRef.current === '' });
    });
    return () => task.cancel();
    // Deliberately keyed on `enabled` alone: album changes have their own
    // effect, and re-running this on every callback identity would re-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // The native observer. Debounced because one save fires several times.
  useEffect(() => {
    if (!enabled || !permissionGranted) return undefined;
    let timer = null;
    const subscription = MediaLibrary.addListener(() => {
      clearTimeout(timer);
      timer = setTimeout(() => { refreshLatest(); }, CHANGE_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      subscription?.remove?.();
    };
  }, [enabled, permissionGranted, refreshLatest]);

  // Coming back from the camera, the gallery, or the settings page: a photo may
  // have been taken and the grant may have changed. syncPermission picks the
  // cheap path when only the former happened.
  useEffect(() => {
    if (!enabled) return undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') syncPermission();
    });
    return () => subscription.remove();
  }, [enabled, syncPermission]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const requestAccess = useCallback(async () => {
    await ensurePermission(PERMISSION_IDS.PHOTOS, {
      purpose: 'Allow access to your photos and videos to share them in chats.',
    });
    // `ensurePermission`'s boolean cannot tell "Allow all" from "Selected
    // photos", and that difference decides what an empty grid means.
    await syncPermission({ initial: true });
  }, [syncPermission]);

  /** Android 14 / iOS limited access: amend which assets the app may see. */
  const manageSelection = useCallback(async () => {
    try {
      await MediaLibrary.presentPermissionsPickerAsync(['photo', 'video']);
    } catch (err) {
      console.warn('[mediaLibrary] permission picker unavailable', err?.message || err);
    }
    await syncPermission({ initial: true });
  }, [syncPermission]);

  const openSettings = useCallback(() => { permissionManager.openSettings(); }, []);

  /**
   * Albums are LAZY. getAlbumsAsync walks every row in MediaStore to count
   * them, which on a 10k-item roll is seconds of native work — never something
   * to run while a sheet is opening. It is fetched the first time the dropdown
   * is actually opened.
   */
  const ensureAlbums = useCallback(() => {
    if (albums !== null) return;
    setAlbums([]); // claim the slot so a double-tap cannot double-fetch
    loadDeviceAlbums()
      .then((list) => { if (aliveRef.current) setAlbums(list); })
      .catch(() => {});
  }, [albums]);

  const selectAlbum = useCallback((next) => {
    setAlbum(next);
    reload(next?.id);
  }, [reload]);

  const retry = useCallback(() => { reload(album?.id); }, [reload, album?.id]);

  return useMemo(() => ({
    assets,
    loading,
    error,
    hasNextPage,
    permissionGranted,
    accessPrivileges,
    isLimited: accessPrivileges === 'limited',
    manifestMissingPhotos: manifestMissingPhotosRef.current,
    albums: albums || [],
    album,
    loadMore,
    retry,
    requestAccess,
    manageSelection,
    openSettings,
    ensureAlbums,
    selectAlbum,
  }), [
    assets, loading, error, hasNextPage, permissionGranted, accessPrivileges,
    albums, album, loadMore, retry, requestAccess, manageSelection, openSettings,
    ensureAlbums, selectAlbum,
  ]);
}
