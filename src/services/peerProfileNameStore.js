/**
 * Peer PROFILE names (the name a user set on their own profile), for avatar
 * letters only.
 *
 * The chat-list rows can't be used for this: their `peerUser.fullName` /
 * `chatName` is the server's per-viewer label — the peer's number, or a stale
 * server-side contact name ("4422localtest" for a user whose profile says
 * "Chetan", verified 2026-09-30). Only `user/auth/view` returns the real
 * profile `fullName`, so it is fetched once per peer per session (deduped,
 * a few at a time) and cached on disk so a cold start draws the right letter
 * straight away.
 */
import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { profileDetails } from '../Redux/Services/Profile/Profile.Services';
import ChatDatabase from './ChatDatabase';
import { isPhoneLikeName } from '../utils/avatarIdentity';

// A peer who turned on "hide contact" gets their profile fullName REDACTED by
// the server to "@handle" (user/auth/view, verified 2026-10-01). That is not a
// name — it must never replace a real one we already know.
const isRealName = (n) => {
  const v = String(n || '').trim();
  return Boolean(v) && !v.startsWith('@') && !isPhoneLikeName(v);
};

const STORAGE_KEY = 'peer_profile_names_v1';
const MAX_CONCURRENT = 3;
const RETRY_AFTER_MS = 60 * 1000;

const names = new Map(); // userId → profile name ('' = fetched, none set)
const fetchedThisSession = new Set();
const inFlight = new Set();
const queue = [];
const listeners = new Set();
let active = 0;
let loaded = false;
let loadPromise = null;
let saveTimer = null;

const notify = () => { listeners.forEach((fn) => { try { fn(); } catch {} }); };

const scheduleSave = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(names))).catch(() => {});
  }, 1500);
};

const loadFromDisk = () => {
  if (loadPromise) return loadPromise;
  loadPromise = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      const obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object') {
        Object.keys(obj).forEach((id) => { if (!names.has(id) && isRealName(obj[id])) names.set(id, String(obj[id]).trim()); });
      }
    })
    .catch(() => {})
    .finally(() => { loaded = true; notify(); });
  return loadPromise;
};

const pump = () => {
  while (active < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    active += 1;
    profileDetails(id)
      .then(async (res) => {
        let full = String(res?.data?.fullName || '').trim();
        if (!isRealName(full)) {
          // Redacted / empty: keep the last real name, else the name they last
          // messaged under.
          if (isRealName(names.get(id))) return;
          const fromMessages = await ChatDatabase.getLatestSenderName(id).catch(() => null);
          full = isRealName(fromMessages) ? String(fromMessages).trim() : '';
        }
        if (names.get(id) !== full) {
          names.set(id, full);
          scheduleSave();
          notify();
        }
      })
      .catch(() => {
        // Retry later (network blip), but not on every render — a deleted
        // account answers "User not found" forever.
        setTimeout(() => { fetchedThisSession.delete(id); }, RETRY_AFTER_MS);
      })
      .finally(() => {
        inFlight.delete(id);
        active -= 1;
        pump();
      });
  }
};

export const getPeerProfileName = (userId) => {
  if (!userId) return null;
  const v = names.get(String(userId));
  return isRealName(v) ? v : null;
};

/** Fetch (once per session) the profile name of `userId`. */
export const ensurePeerProfileName = (userId) => {
  const id = userId ? String(userId) : '';
  if (!id || fetchedThisSession.has(id) || inFlight.has(id)) return;
  fetchedThisSession.add(id);
  inFlight.add(id);
  queue.push(id);
  if (!loaded) loadFromDisk();
  pump();
};

/** Live profile name for an avatar letter; fetches it when `enabled`. */
export const usePeerProfileName = (userId, enabled = true) => {
  const [, setTick] = useState(0);
  useEffect(() => {
    const fn = () => setTick((t) => t + 1);
    listeners.add(fn);
    if (!loaded) loadFromDisk();
    return () => { listeners.delete(fn); };
  }, []);
  useEffect(() => {
    if (enabled && userId) ensurePeerProfileName(userId);
  }, [enabled, userId]);
  return getPeerProfileName(userId);
};
