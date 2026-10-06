/**
 * Durable local copy of the image a status reply quotes.
 *
 * A status-reply bubble only stores the S3 presigned URL it had at send time.
 * Those links expire after 1h and the status itself after 24h, so the quote
 * card went blank (gray box) and tapping it opened a black viewer. WhatsApp
 * keeps the thumbnail forever — so do we: the first time the card's image
 * loads, a copy is saved under documentDirectory/status-thumbs/<statusId>.jpg
 * and preferred from then on (card + the "status unavailable" modal).
 */
import { useEffect, useState } from 'react';
import * as FileSystem from 'expo-file-system/legacy';

const DIR = `${FileSystem.documentDirectory || ''}status-thumbs/`;

const known = new Map(); // statusId → local file uri | null (checked, none)
const pending = new Set();
const listeners = new Set();
let dirReady = null;

const notify = () => { listeners.forEach((fn) => { try { fn(); } catch {} }); };
const fileFor = (statusId) => `${DIR}${String(statusId).replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`;

const ensureDir = () => {
  if (!dirReady) {
    dirReady = FileSystem.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
  }
  return dirReady;
};

const check = async (statusId) => {
  if (!statusId || known.has(statusId) || pending.has(statusId)) return;
  pending.add(statusId);
  try {
    const info = await FileSystem.getInfoAsync(fileFor(statusId));
    known.set(statusId, info?.exists && info.size > 0 ? info.uri : null);
  } catch {
    known.set(statusId, null);
  } finally {
    pending.delete(statusId);
    notify();
  }
};

export const getLocalStatusThumb = (statusId) => (statusId ? known.get(String(statusId)) || null : null);

/** Save a copy of `remoteUrl` for `statusId` (no-op if one already exists). */
export const saveStatusThumb = async (statusId, remoteUrl) => {
  const id = statusId ? String(statusId) : '';
  if (!id || !/^https?:\/\//i.test(String(remoteUrl || '')) || getLocalStatusThumb(id) || pending.has(id)) return;
  pending.add(id);
  try {
    await ensureDir();
    const target = fileFor(id);
    const res = await FileSystem.downloadAsync(String(remoteUrl), target);
    const info = await FileSystem.getInfoAsync(target);
    if (res?.status === 200 && info?.exists && info.size > 0) {
      known.set(id, info.uri);
      notify();
    } else {
      // Expired link (403) etc. — don't keep an error body as the "image".
      FileSystem.deleteAsync(target, { idempotent: true }).catch(() => {});
    }
  } catch {
    /* network blip — the next successful render tries again */
  } finally {
    pending.delete(id);
  }
};

/** Local copy of a status thumbnail, re-rendering once it is known/saved. */
export const useLocalStatusThumb = (statusId) => {
  const id = statusId ? String(statusId) : '';
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    if (id) check(id);
    return () => { listeners.delete(fn); };
  }, [id]);
  return getLocalStatusThumb(id);
};
