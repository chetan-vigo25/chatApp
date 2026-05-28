import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchStatusSettings } from '../Redux/Reducer/Status/Status.reducer';

const FRESH_FOR_MS = 5 * 60 * 1000; // re-fetch settings at most every 5 min

/**
 * useStatusSettings()
 *
 * Returns the dynamic STATUS_* limits and a `validateMedia()` helper for
 * pre-upload checks. Auto-fetches once on mount and refreshes if the cached
 * snapshot is older than FRESH_FOR_MS.
 *
 * The validators take the media item shape returned by ImagePicker (`uri`,
 * `mimeType`, `fileSize`, `duration`, `type`) and return either
 *   { ok: true }
 * or
 *   { ok: false, code, message }
 * The caller is responsible for surfacing `message` (toast, alert, snackbar).
 */
export default function useStatusSettings() {
  const dispatch = useDispatch();
  const settings = useSelector((s) => s.status?.settings);
  const fetchedAt = useSelector((s) => s.status?.settingsFetchedAt || 0);
  const inFlight = useRef(false);

  useEffect(() => {
    const stale = Date.now() - fetchedAt > FRESH_FOR_MS;
    if (stale && !inFlight.current) {
      inFlight.current = true;
      Promise.resolve(dispatch(fetchStatusSettings())).finally(() => {
        inFlight.current = false;
      });
    }
  }, [dispatch, fetchedAt]);

  const limits = useMemo(() => ({
    maxImageBytes: (settings?.STATUS_MAX_IMAGE_SIZE_MB || 10) * 1024 * 1024,
    maxVideoBytes: (settings?.STATUS_MAX_VIDEO_SIZE_MB || 50) * 1024 * 1024,
    maxVideoSecs:  settings?.STATUS_MAX_VIDEO_SECS || 60,
    durationHours: settings?.STATUS_DURATION_HOURS || 24,
    allowDownloadDefault: settings?.STATUS_ALLOW_DOWNLOAD_DEFAULT !== false,
  }), [settings]);

  const validateMedia = useCallback((item) => {
    if (!item || !item.uri) {
      return { ok: false, code: 'no_file', message: 'No file selected' };
    }

    const mime = (item.mimeType || '').toLowerCase();
    const isVideo = item.type === 'video' || mime.startsWith('video/');
    const isImage = item.type === 'image' || mime.startsWith('image/');

    if (!isVideo && !isImage) {
      return { ok: false, code: 'unsupported_format', message: 'Unsupported media format' };
    }

    const size = Number(item.fileSize) || 0;

    if (isImage) {
      if (size > 0 && size > limits.maxImageBytes) {
        return {
          ok: false,
          code: 'image_too_large',
          message: `Image exceeds ${settings?.STATUS_MAX_IMAGE_SIZE_MB || 10}MB upload limit`,
        };
      }
      return { ok: true };
    }

    // Video checks
    if (size > 0 && size > limits.maxVideoBytes) {
      return {
        ok: false,
        code: 'video_too_large',
        message: `Video exceeds ${settings?.STATUS_MAX_VIDEO_SIZE_MB || 50}MB upload limit`,
      };
    }

    // ImagePicker returns duration in ms; tolerate either ms or s
    const rawDuration = Number(item.duration) || 0;
    const durationSecs = rawDuration > 1000 ? rawDuration / 1000 : rawDuration;
    if (durationSecs > 0 && durationSecs > limits.maxVideoSecs) {
      return {
        ok: false,
        code: 'video_too_long',
        message: `Video duration exceeds ${limits.maxVideoSecs}s limit`,
      };
    }
    return { ok: true };
  }, [limits, settings]);

  /** Validate an array; returns the first failure or { ok: true }. */
  const validateMediaList = useCallback((items) => {
    for (const it of items || []) {
      const r = validateMedia(it);
      if (!r.ok) return r;
    }
    return { ok: true };
  }, [validateMedia]);

  const refresh = useCallback(() => dispatch(fetchStatusSettings()), [dispatch]);

  return { settings, limits, validateMedia, validateMediaList, refresh };
}
