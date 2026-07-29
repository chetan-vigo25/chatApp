// Drop-in replacement for the DEPRECATED expo-av <Video> component, backed by
// expo-video (useVideoPlayer + VideoView). Exposes the same props and ref
// methods our screens already use, so call sites only swap the import:
//
//   props : source{uri}, style, resizeMode, shouldPlay, isLooping, isMuted,
//           progressUpdateIntervalMillis, onPlaybackStatusUpdate, onError,
//           useNativeControls
//   ref   : playAsync(), pauseAsync(), setPositionAsync(ms), getStatusAsync()
//
// Status objects keep the expo-av shape (positionMillis/durationMillis in MS,
// isLoaded/isPlaying/didJustFinish) — expo-video itself works in SECONDS, the
// conversion lives here and only here. Never import Video from 'expo-av' again.
import React, {
  forwardRef, useEffect, useImperativeHandle, useRef,
} from 'react';
import { useVideoPlayer, VideoView } from 'expo-video';

export const ResizeMode = {
  CONTAIN: 'contain',
  COVER: 'cover',
  STRETCH: 'fill',
};

const toContentFit = (resizeMode) => {
  if (resizeMode === ResizeMode.COVER) return 'cover';
  if (resizeMode === ResizeMode.STRETCH) return 'fill';
  return 'contain';
};

export const Video = forwardRef(({
  source,
  style,
  resizeMode = ResizeMode.CONTAIN,
  shouldPlay = false,
  isLooping = false,
  isMuted = false,
  progressUpdateIntervalMillis = 250,
  onPlaybackStatusUpdate = null,
  onError = null,
  useNativeControls = false,
}, ref) => {
  const uri = source?.uri || null;

  // Latest callbacks/flags in refs so player listeners never go stale.
  const statusCbRef = useRef(onPlaybackStatusUpdate);
  statusCbRef.current = onPlaybackStatusUpdate;
  const errorCbRef = useRef(onError);
  errorCbRef.current = onError;
  const finishedRef = useRef(false);
  const loadedRef = useRef(false);

  const player = useVideoPlayer(uri, (p) => {
    p.loop = !!isLooping;
    p.muted = !!isMuted;
    p.timeUpdateEventInterval = Math.max(0.05, Number(progressUpdateIntervalMillis || 250) / 1000);
    if (shouldPlay) p.play();
  });

  const buildStatus = (extra = {}) => ({
    isLoaded: loadedRef.current,
    isPlaying: !!player.playing,
    positionMillis: Math.max(0, Math.round((player.currentTime || 0) * 1000)),
    durationMillis: Math.max(0, Math.round((player.duration || 0) * 1000)),
    didJustFinish: false,
    ...extra,
  });
  const emitStatus = (extra) => {
    const cb = statusCbRef.current;
    if (typeof cb === 'function') {
      try { cb(buildStatus(extra)); } catch { /* consumer error — never break playback */ }
    }
  };
  const emitRef = useRef(emitStatus);
  emitRef.current = emitStatus;

  // Source swap on an EXISTING player (the hook does not reload on uri change).
  const firstUriRef = useRef(uri);
  useEffect(() => {
    if (uri === firstUriRef.current) return;
    firstUriRef.current = uri;
    loadedRef.current = false;
    finishedRef.current = false;
    try {
      if (typeof player.replaceAsync === 'function') player.replaceAsync(uri).catch(() => {});
      else player.replace(uri);
      if (shouldPlay) player.play();
    } catch { /* invalid source — statusChange('error') reports it */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uri]);

  // Prop → player sync (each idempotent).
  useEffect(() => { try { player.loop = !!isLooping; } catch {} }, [player, isLooping]);
  useEffect(() => { try { player.muted = !!isMuted; } catch {} }, [player, isMuted]);
  useEffect(() => {
    try {
      if (shouldPlay) player.play();
      else player.pause();
    } catch {}
  }, [player, shouldPlay]);

  // Player events → expo-av style status callbacks.
  useEffect(() => {
    const subs = [
      player.addListener('statusChange', (payload = {}) => {
        const st = payload?.status || payload;
        if (st === 'readyToPlay') {
          loadedRef.current = true;
          emitRef.current();
        } else if (st === 'error') {
          loadedRef.current = false;
          const err = payload?.error?.message || 'video failed to load';
          const cb = errorCbRef.current;
          if (typeof cb === 'function') { try { cb(err); } catch {} }
          const scb = statusCbRef.current;
          if (typeof scb === 'function') {
            try { scb({ isLoaded: false, error: err }); } catch {}
          }
        }
      }),
      player.addListener('playingChange', () => { emitRef.current(); }),
      player.addListener('timeUpdate', () => {
        if (loadedRef.current) emitRef.current();
      }),
      player.addListener('playToEnd', () => {
        finishedRef.current = true;
        emitRef.current({ didJustFinish: true, isPlaying: false });
      }),
    ];
    return () => { subs.forEach((s) => { try { s.remove(); } catch {} }); };
  }, [player]);

  useImperativeHandle(ref, () => ({
    playAsync: async () => { player.play(); return buildStatus(); },
    pauseAsync: async () => { player.pause(); return buildStatus(); },
    setPositionAsync: async (positionMillis) => {
      player.currentTime = Math.max(0, Number(positionMillis || 0) / 1000);
      return buildStatus();
    },
    setIsMutedAsync: async (muted) => { player.muted = !!muted; return buildStatus(); },
    getStatusAsync: async () => buildStatus(),
  }), [player]);

  return (
    <VideoView
      player={player}
      style={style}
      contentFit={toContentFit(resizeMode)}
      nativeControls={!!useNativeControls}
    />
  );
});

export default Video;
