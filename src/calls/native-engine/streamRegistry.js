/**
 * Live MediaStream registry for the NATIVE call engine.
 *
 * The WebView engine rendered remote/local video INSIDE the WebView (its <video>
 * tiles). Natively the UI renders <RTCView streamURL={...}> instead, so the
 * engine publishes its streams here and NativeVideoStage subscribes.
 *
 * Keys mirror the SDK's streamKey scheme: `<peerId>` for camera+mic,
 * `<peerId>#screen` for a screen share. Plain module state + subscribers —
 * no Redux (streams are non-serializable and short-lived).
 */
let localEntry = null; // { stream, facing, hasVideo }
const remote = new Map(); // streamKey -> { peerId, stream, source, hasVideo }
const listeners = new Set();

const notify = () => { listeners.forEach((fn) => { try { fn(); } catch (_) {} }); };

const hasVideoTracks = (stream) => {
  try { return !!(stream && stream.getVideoTracks && stream.getVideoTracks().length); } catch (_) { return false; }
};

export const setLocalStream = (stream, facing = 'user') => {
  localEntry = stream ? { stream, facing, hasVideo: hasVideoTracks(stream) } : null;
  notify();
};

export const setLocalFacing = (facing) => {
  if (localEntry) { localEntry = { ...localEntry, facing }; notify(); }
};

// The local stream's tracks change in place (camera upgrade / switch) — let the
// engine poke the registry so subscribers re-read hasVideo.
export const refreshLocal = () => {
  if (localEntry) { localEntry = { ...localEntry, hasVideo: hasVideoTracks(localEntry.stream) }; notify(); }
};

export const setRemoteStream = (streamKey, peerId, stream, source) => {
  remote.set(String(streamKey), {
    peerId: peerId != null ? String(peerId) : null,
    stream,
    source: source || null,
    hasVideo: hasVideoTracks(stream),
  });
  notify();
};

export const refreshRemote = (streamKey) => {
  const e = remote.get(String(streamKey));
  if (e) { remote.set(String(streamKey), { ...e, hasVideo: hasVideoTracks(e.stream) }); notify(); }
};

export const removeRemote = (streamKey) => {
  if (remote.delete(String(streamKey))) notify();
};

export const dropPeer = (peerId) => {
  const pid = String(peerId);
  let changed = false;
  if (remote.delete(pid)) changed = true;
  if (remote.delete(`${pid}#screen`)) changed = true;
  if (changed) notify();
};

export const clearAll = () => {
  localEntry = null;
  remote.clear();
  notify();
};

export const getSnapshot = () => ({
  local: localEntry,
  remotes: Array.from(remote.entries()).map(([key, e]) => ({ key, ...e })),
});

export const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
