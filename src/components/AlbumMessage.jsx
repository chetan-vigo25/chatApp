import React, { useMemo, useState, useRef, useCallback, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { toSecureMediaUri, mediaResolve } from '../utils/mediaService';
import { generateLocalVideoThumbnail } from '../utils/thumbnailGenerator';
import useMediaDownload from '../hooks/useMediaDownload';
import UploadRing from './UploadRing';
import BlurGateImage from './BlurGateImage';

// mediaId → server thumbnailUrl (or null). Album video items sent before
// server thumbnails existed carry mediaThumbnailUrl:null — resolve fetches a
// fresh poster ONCE per session (the call also self-heals the missing
// thumbnail server-side).
const videoThumbCache = new Map();

const GRID_WIDTH = 220;
const GAP = 3;
const MAX_VISIBLE = 4;

const normalizeMediaId = (raw) => {
  if (!raw) return null;
  if (typeof raw === 'object') return String(raw.$oid || raw._id || raw.id || '');
  return String(raw);
};

const isVisual = (item) => item?.fileCategory === 'image' || item?.fileCategory === 'video';

const formatBytes = (bytes) => {
  const n = Number(bytes || 0);
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * Per-tile overlay is now DECORATION only (+N badge, video play glyph).
 * All transfer states (upload ring, retry, download ring/button) live on the
 * ONE album-level center overlay — WhatsApp style: a single ring that runs
 * until every file has moved.
 */
function TileOverlay({ item, hiddenCount, available }) {
  if (hiddenCount > 0) {
    return (
      <View style={styles.dimOverlay} pointerEvents="none">
        <Text style={styles.moreText}>+{hiddenCount}</Text>
      </View>
    );
  }
  if (available && item.fileCategory === 'video') {
    return (
      <View style={styles.playOverlay} pointerEvents="none">
        <View style={styles.playCircle}>
          <Ionicons name="play" size={18} color="#fff" style={styles.playIcon} />
        </View>
      </View>
    );
  }
  return null;
}

// Memoized: during an album upload only the PATCHED item gets a new object
// identity (patchItem maps the array but keeps unchanged entries), so with
// stable shared props the other tiles skip re-rendering entirely.
const Tile = React.memo(function Tile({
  item,
  index,
  height,
  width,
  hiddenCount,
  onPressItem,
  onLongPressItem,
  isMine,
  chatId,
  messageId,
  onLockedPress,
  reportTile,
  registerTile,
}) {
  const mediaId = normalizeMediaId(item?.mediaId);
  const {
    status,
    progress,
    localPath,
    isDownloaded,
    requestDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
  } = useMediaDownload(mediaId);

  // Own media is already local. Received media is gated until downloaded.
  const isSending = item.uploadStatus === 'uploading' || item.uploadStatus === 'pending';
  const available = isMine || isSending || isDownloaded || Boolean(item?.localUri);
  const downloading = !available && (status === 'downloading' || status === 'queued');
  const downloadPaused = !available && status === 'paused';

  const localUri = localPath || item?.localUri || null;
  const isVideo = item?.fileCategory === 'video';

  // Legacy video items have no poster URL — ask the server once per session.
  const [resolvedThumb, setResolvedThumb] = useState(
    () => (mediaId && videoThumbCache.get(mediaId)) || null,
  );

  // Video with the file ON DEVICE but no poster (localThumbUri lost to an ack
  // merge / reload, or sent by an old build): extract the frame locally —
  // instant and offline; beats a network resolve round-trip.
  const [localGenThumb, setLocalGenThumb] = useState(null);
  const localVideoSrc = isVideo && !item?.localThumbUri && !item?.mediaThumbnailUrl
    ? [localUri, item?.localUri].find((u) => typeof u === 'string' && /^(file|content):\/\//i.test(u)) || null
    : null;
  useEffect(() => {
    if (!localVideoSrc || localGenThumb) return undefined;
    let alive = true;
    generateLocalVideoThumbnail(localVideoSrc)
      .then((thumb) => { if (alive && thumb) setLocalGenThumb(thumb); })
      .catch(() => {});
    return () => { alive = false; };
  }, [localVideoSrc, localGenThumb]);

  useEffect(() => {
    if (!isVideo || item?.mediaThumbnailUrl || item?.localThumbUri || !mediaId) return undefined;
    if (videoThumbCache.has(mediaId)) {
      const cached = videoThumbCache.get(mediaId);
      if (cached) setResolvedThumb(cached);
      return undefined;
    }
    videoThumbCache.set(mediaId, null); // in-flight marker — one request per id
    let alive = true;
    mediaResolve([mediaId])
      .then((map) => {
        const entry = map?.[mediaId];
        const it = Array.isArray(entry?.items) ? entry.items[0] : entry;
        const thumb = it?.thumbnailUrl || null;
        videoThumbCache.set(mediaId, thumb);
        if (alive && thumb) setResolvedThumb(thumb);
      })
      .catch(() => { videoThumbCache.delete(mediaId); });
    return () => { alive = false; };
  }, [isVideo, mediaId, item?.mediaThumbnailUrl]);

  // Video tiles ALWAYS render a poster image (never the video file — an .mp4
  // in <Image> paints black, downloaded or not); images use the local file
  // once present.
  const posterUri = isVideo
    ? (item?.localThumbUri || localGenThumb || item?.mediaThumbnailUrl || resolvedThumb || null)
    : (localUri || item?.mediaThumbnailUrl || item?.mediaUrl || null);
  const source = posterUri ? toSecureMediaUri(posterUri) : null;

  const downloadDescriptor = {
    chatId,
    messageType: item?.fileCategory || 'image',
    filename: item?.mediaMeta?.fileName || mediaId || `${index}`,
    mediaUrl: item?.mediaUrl || null,
    messageId,
    // Ring math fallback for responses without Content-Length.
    fileSize: Number(item?.mediaMeta?.fileSize || 0) || null,
    // sha256 of the STORED bytes — authoritative post-download verify
    // (fileSize is pre-optimization and can't be trusted for images).
    contentHash: item?.mediaMeta?.contentHash || null,
  };

  // Report live state up so the album can render ONE aggregate ring.
  // progress is ROUNDED before it crosses the boundary: the parent's
  // setTileStates equality guard compares with ===, and raw floats arriving
  // many times a second never bail out — with a large album that render↔effect
  // cascade was a "Maximum update depth exceeded" crash during upload.
  const roundedProgress = Math.round(Number(progress || 0));
  useEffect(() => {
    reportTile?.(index, {
      status,
      progress: roundedProgress,
      available,
    });
  }, [reportTile, index, status, roundedProgress, available]);

  // Hand the album-level overlay imperative control of this tile's transfer.
  // Registered ONCE per stable identity (was dep-less = every commit); the
  // callbacks read the LATEST descriptor through a ref, so the registration
  // never needs to re-run just because a progress patch rebuilt the item.
  const descriptorRef = useRef(downloadDescriptor);
  descriptorRef.current = downloadDescriptor;
  useEffect(() => {
    registerTile?.(index, {
      requestDownload: () => requestDownload(descriptorRef.current),
      pauseDownload: () => pauseDownload(),
      resumeDownload: () => resumeDownload(descriptorRef.current),
      cancelDownload: () => cancelDownload(),
    });
  }, [registerTile, index, requestDownload, pauseDownload, resumeDownload, cancelDownload]);

  const handlePress = () => {
    if (isSending || downloading || downloadPaused) return;
    if (available) {
      onPressItem?.({ ...item, localUri: localUri || item?.localUri || null }, index);
      return;
    }
    // Receiver tap on any locked tile → the ALBUM downloads (single ring).
    onLockedPress?.();
  };

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={handlePress}
      onLongPress={onLongPressItem || undefined}
      delayLongPress={300}
      style={[styles.tile, { width, height }]}
    >
      {isVisual(item) && source ? (
        <BlurGateImage
          uri={source}
          style={styles.tileImage}
          resizeMode="cover"
          gated={!available}
          active={downloading}
          paused={downloadPaused}
          progress={Math.min(100, Number(progress || 0)) / 100}
        />
      ) : isVisual(item) ? (
        // Image/video with NO poster yet (local frame still extracting, or a
        // legacy row awaiting the server thumbnail): a soft frosted placeholder
        // instead of a filename tile — the real thumbnail swaps in when ready.
        <View style={styles.blurTile}>
          <BlurView
            intensity={30}
            tint="dark"
            experimentalBlurMethod="dimezisBlurView"
            style={StyleSheet.absoluteFill}
          />
          {/* Video tiles that are `available` already get a play glyph from
              TileOverlay — don't double it up. */}
          {!(available && item.fileCategory === 'video') && (
            <View style={styles.blurGlyph}>
              <Ionicons
                name={item.fileCategory === 'video' ? 'play' : 'image'}
                size={18}
                color="rgba(255,255,255,0.9)"
                style={item.fileCategory === 'video' ? styles.playIcon : null}
              />
            </View>
          )}
        </View>
      ) : (
        <View style={styles.fileTile}>
          <Ionicons
            name={item.fileCategory === 'audio' ? 'musical-notes' : 'document-text'}
            size={22}
            color="rgba(255,255,255,0.85)"
          />
          <Text style={styles.fileName} numberOfLines={1}>
            {item?.mediaMeta?.fileName || 'File'}
          </Text>
        </View>
      )}
      <TileOverlay item={item} hiddenCount={hiddenCount} available={available} />
    </TouchableOpacity>
  );
});

/**
 * WhatsApp-style album bubble (N attachments in ONE message).
 *   2 items  → 2 columns
 *   3 items  → 1 large on top + 2 below
 *   4 items  → 2 × 2 grid
 *   5+ items → 2 × 2 grid, last tile shows "+N"
 * ONE center ring covers the whole album for BOTH directions: upload shows
 * aggregate progress until every file is up (pause/resume/cancel act on the
 * whole queue row); receiver gets a single download pill → single ring while
 * files come down one after another (tiles un-blur individually as each
 * finishes).
 */
export default function AlbumMessage({
  message,
  onPressItem,
  onLongPressItem = null,
  isMine = false,
  uploadPaused = false,
  uploadCancelled = false,
  onPauseUpload = null,
  onResumeUpload = null,
  onCancelUpload = null,
  onRetryUpload = null,
}) {
  const items = useMemo(
    () => (Array.isArray(message?.mediaItems) ? message.mediaItems : []),
    [message?.mediaItems],
  );

  const chatId = message?.chatId || message?.roomId || null;
  const messageId = message?.messageId || message?.serverMessageId
    || (message?._id?.$oid ? String(message._id.$oid) : message?._id) || message?.id || null;

  // ── Album-level aggregate UPLOAD state ────────────────────────────────
  // Ring only while the MESSAGE itself is still outbound: once it's
  // uploaded/sent/acked, a stale mediaItems snapshot (e.g. a queue replay or
  // SQLite reload) must never flash the progress ring back onto the bubble.
  const outbound = ['sending', 'uploading'].includes(String(message?.status || ''));
  const anyUploading = outbound
    && items.some((it) => it.uploadStatus === 'uploading' || it.uploadStatus === 'pending');
  const anyUploadFailed = items.some((it) => it.uploadStatus === 'failed');
  const uploadCancelledPending = uploadCancelled && items.some((it) => it.uploadStatus !== 'done');
  const uploadPct = items.length
    ? items.reduce((sum, it) => {
        if (!it.uploadStatus || it.uploadStatus === 'done') return sum + 100;
        return sum + Math.min(100, Number(it.uploadProgress || 0));
      }, 0) / items.length
    : 0;

  // ── Album-level aggregate DOWNLOAD state (lifted from the tiles) ──────
  const [tileStates, setTileStates] = useState({});
  const controlsRef = useRef({});
  const registerTile = useCallback((index, api) => { controlsRef.current[index] = api; }, []);
  const reportTile = useCallback((index, st) => {
    setTileStates((prev) => {
      const cur = prev[index];
      if (cur && cur.status === st.status && cur.progress === st.progress && cur.available === st.available) {
        return prev;
      }
      return { ...prev, [index]: st };
    });
  }, []);

  const visibleCount = Math.min(items.length, MAX_VISIBLE);
  const lockedIdx = [];
  for (let i = 0; i < visibleCount; i += 1) {
    const st = tileStates[i];
    if (!isMine && st && !st.available) lockedIdx.push(i);
  }
  const dlStatuses = lockedIdx.map((i) => tileStates[i]?.status);
  const anyDownloading = dlStatuses.some((s) => s === 'downloading' || s === 'queued');
  const anyDlPaused = dlStatuses.some((s) => s === 'paused');
  // Aggregate over every visible tile: finished tiles count 100.
  const dlPct = visibleCount
    ? Array.from({ length: visibleCount }).reduce((sum, _, i) => {
        const st = tileStates[i];
        if (!st || st.available) return sum + 100;
        return sum + Math.min(100, Number(st.progress || 0));
      }, 0) / visibleCount
    : 0;
  const lockedSize = lockedIdx.reduce((sum, i) => sum + Number(items[i]?.mediaMeta?.fileSize || 0), 0);

  // The group-action callbacks read lockedIdx/tileStates through refs so they
  // stay REFERENTIALLY STABLE across renders — lockedIdx is a fresh array every
  // render, and keying useCallback on it rebuilt every callback (and therefore
  // `shared`, and therefore every Tile) on every upload-progress patch. That
  // churn is what let the tile→album report cascade run away on large albums.
  const lockedIdxRef = useRef(lockedIdx);
  lockedIdxRef.current = lockedIdx;
  const tileStatesRef = useRef(tileStates);
  tileStatesRef.current = tileStates;
  const downloadAll = useCallback(() => {
    lockedIdxRef.current.forEach((i) => {
      const p = controlsRef.current[i]?.requestDownload?.();
      if (p?.catch) p.catch(() => {});
    });
  }, []);
  const pauseAllDownloads = useCallback(() => {
    lockedIdxRef.current.forEach((i) => controlsRef.current[i]?.pauseDownload?.());
  }, []);
  const resumeAllDownloads = useCallback(() => {
    lockedIdxRef.current.forEach((i) => {
      const st = tileStatesRef.current[i];
      if (st?.status === 'paused') {
        const p = controlsRef.current[i]?.resumeDownload?.();
        if (p?.catch) p.catch(() => {});
      }
    });
  }, []);
  const cancelAllDownloads = useCallback(() => {
    lockedIdxRef.current.forEach((i) => controlsRef.current[i]?.cancelDownload?.());
  }, []);

  const shared = useMemo(() => ({
    onPressItem,
    onLongPressItem,
    isMine,
    chatId,
    messageId,
    onLockedPress: downloadAll,
    reportTile,
    registerTile,
  }), [onPressItem, onLongPressItem, isMine, chatId, messageId, downloadAll, reportTile, registerTile]);

  if (!items.length) return null;

  const visible = items.slice(0, MAX_VISIBLE);
  const hidden = items.length - MAX_VISIBLE;
  const half = (GRID_WIDTH - GAP) / 2;

  let grid = null;
  if (items.length === 1) {
    grid = (
      <Tile item={visible[0]} index={0} width={GRID_WIDTH} height={GRID_WIDTH} hiddenCount={0} {...shared} />
    );
  } else if (items.length === 2) {
    grid = (
      <View style={styles.row}>
        {visible.map((item, i) => (
          <Tile key={i} item={item} index={i} width={half} height={150} hiddenCount={0} {...shared} />
        ))}
      </View>
    );
  } else if (items.length === 3) {
    grid = (
      <View>
        <Tile item={visible[0]} index={0} width={GRID_WIDTH} height={140} hiddenCount={0} {...shared} />
        <View style={[styles.row, styles.rowGapTop]}>
          {visible.slice(1).map((item, i) => (
            <Tile key={i} item={item} index={i + 1} width={half} height={108} hiddenCount={0} {...shared} />
          ))}
        </View>
      </View>
    );
  } else {
    grid = (
      <View>
        <View style={styles.row}>
          {visible.slice(0, 2).map((item, i) => (
            <Tile key={i} item={item} index={i} width={half} height={108} hiddenCount={0} {...shared} />
          ))}
        </View>
        <View style={[styles.row, styles.rowGapTop]}>
          {visible.slice(2).map((item, i) => (
            <Tile
              key={i}
              item={item}
              index={i + 2}
              width={half}
              height={108}
              hiddenCount={i === 1 ? hidden : 0}
              {...shared}
            />
          ))}
        </View>
      </View>
    );
  }

  // ── ONE center overlay for the whole album ────────────────────────────
  let centerOverlay = null;
  if (uploadCancelledPending || (!anyUploading && anyUploadFailed)) {
    centerOverlay = (
      <TouchableOpacity
        onPress={onRetryUpload || undefined}
        disabled={!onRetryUpload}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={styles.retryCircle}
        activeOpacity={0.8}
      >
        <Ionicons name="refresh" size={20} color="#fff" />
      </TouchableOpacity>
    );
  } else if (anyUploading) {
    const doneUploadCount = items.filter((it) => it.uploadStatus === 'done').length;
    centerOverlay = (
      <View style={styles.centerStack}>
        <UploadRing
          percent={uploadPct}
          size={48}
          paused={uploadPaused}
          onPause={onPauseUpload}
          onResume={onResumeUpload}
          onCancel={onCancelUpload}
        />
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{doneUploadCount}/{items.length}</Text>
        </View>
      </View>
    );
  } else if (!isMine && (anyDownloading || anyDlPaused)) {
    const dlDoneCount = Array.from({ length: visibleCount })
      .reduce((n, _, i) => n + (tileStates[i]?.available ? 1 : 0), 0);
    centerOverlay = (
      <View style={styles.centerStack}>
        <UploadRing
          percent={dlPct}
          size={48}
          paused={!anyDownloading && anyDlPaused}
          onPause={pauseAllDownloads}
          onResume={resumeAllDownloads}
          onCancel={cancelAllDownloads}
        />
        <View style={styles.countBadge}>
          <Text style={styles.countText}>{dlDoneCount}/{visibleCount}</Text>
        </View>
      </View>
    );
  } else if (!isMine && lockedIdx.length > 0) {
    centerOverlay = (
      <TouchableOpacity onPress={downloadAll} style={styles.downloadPill} activeOpacity={0.85}>
        <Ionicons name="cloud-download" size={16} color="#fff" />
        <Text style={styles.downloadPillText}>
          {lockedSize ? formatBytes(lockedSize) : 'Download'}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      {grid}
      {centerOverlay ? (
        <View style={styles.centerOverlay} pointerEvents="box-none">
          {centerOverlay}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: GRID_WIDTH,
    position: 'relative',
  },
  row: {
    flexDirection: 'row',
    gap: GAP,
  },
  rowGapTop: {
    marginTop: GAP,
  },
  tile: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  blurTile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(120,130,135,0.35)',
    overflow: 'hidden',
  },
  blurGlyph: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fileTile: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 8,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  fileName: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 10,
    fontFamily: 'Roboto-Regular',
    maxWidth: '100%',
  },
  dimOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerStack: {
    alignItems: 'center',
    gap: 6,
  },
  countBadge: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  countText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'Roboto-Medium',
  },
  moreText: {
    color: '#fff',
    fontSize: 22,
    fontFamily: 'Roboto-Medium',
  },
  downloadPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  downloadPillText: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Roboto-Medium',
  },
  retryCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1.5,
    borderColor: '#03b0a2',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {
    marginLeft: 2,
  },
});
