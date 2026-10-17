/**
 * Unsent composer text per chat (WhatsApp-style drafts). Client-only.
 *
 * ChatScreen writes the box's text here as the user types and when they leave;
 * the chat list reads it to show a green "Draft:" preview. Reopening the chat
 * puts the text back in the box. Sending (box empty) clears the draft.
 *
 * Kept in memory for the synchronous row render and mirrored to the account's
 * MMKV store (services/kvStorage) so it survives an app restart. Logout's
 * clearAccount() wipes the disk copy;
 * the session-reset subscription below drops the in-memory one, so a draft can
 * never show up under the next account.
 */
import { useEffect, useState } from 'react';
import { kv } from './kvStorage';
import { subscribeSessionReset, subscribeUserChanged } from './sessionEvents';

const STORAGE_KEY = 'chat_drafts_v1';
const MAX_DRAFT_LENGTH = 65536;

const drafts = new Map(); // chatId → { text, updatedAt }
const listeners = new Set();
let loadPromise = null;
let saveTimer = null;
// Bumped on reset so a disk read that started before logout can't refill the map.
let generation = 0;

const keyOf = (chatId) => (chatId ? String(chatId) : '');

const notify = (chatId) => { listeners.forEach((fn) => { try { fn(chatId); } catch {} }); };

const scheduleSave = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    kv.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(drafts))).catch(() => {});
  }, 400);
};

export const loadChatDrafts = () => {
  if (loadPromise) return loadPromise;
  const gen = generation;
  loadPromise = kv.getItem(STORAGE_KEY)
    .then((raw) => {
      if (gen !== generation) return;
      const obj = raw ? JSON.parse(raw) : null;
      if (!obj || typeof obj !== 'object') return;
      Object.keys(obj).forEach((id) => {
        const text = obj[id]?.text;
        // A draft written this session (before the read finished) wins.
        if (!drafts.has(id) && typeof text === 'string' && text.trim()) {
          drafts.set(id, { text, updatedAt: Number(obj[id].updatedAt) || 0 });
        }
      });
    })
    .catch(() => {})
    .finally(() => { if (gen === generation) notify(null); });
  return loadPromise;
};

export const getChatDraft = (chatId) => drafts.get(keyOf(chatId))?.text || '';

/** Store the composer text; blank text removes the draft. */
export const setChatDraft = (chatId, text) => {
  const id = keyOf(chatId);
  if (!id) return;
  const value = typeof text === 'string' ? text.slice(0, MAX_DRAFT_LENGTH) : '';
  const prev = drafts.get(id)?.text || '';
  if (!value.trim()) {
    if (!drafts.has(id)) return;
    drafts.delete(id);
  } else {
    if (prev === value) return;
    drafts.set(id, { text: value, updatedAt: Date.now() });
  }
  scheduleSave();
  notify(id);
};

export const clearChatDraft = (chatId) => setChatDraft(chatId, '');

const resetDrafts = () => {
  generation += 1;
  loadPromise = null;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  // A save that landed after logout's storage wipe would carry the old
  // account's drafts into the next one.
  kv.removeItem(STORAGE_KEY).catch(() => {});
  if (drafts.size === 0) return;
  drafts.clear();
  notify(null);
};
subscribeSessionReset(resetDrafts);
// Fires on every boot with the same user too — only a real switch (or sign-out)
// drops the drafts.
let lastUserId;
subscribeUserChanged(({ userId } = {}) => {
  const next = userId ? String(userId) : null;
  if (lastUserId !== undefined && next !== lastUserId) resetDrafts();
  lastUserId = next;
});

/** Live draft text of one chat ('' when none) — re-renders only that row. */
export const useChatDraft = (chatId) => {
  const id = keyOf(chatId);
  const [text, setText] = useState(() => getChatDraft(id));
  useEffect(() => {
    const fn = (changedId) => {
      if (changedId === null || changedId === id) setText(getChatDraft(id));
    };
    listeners.add(fn);
    fn(null);
    loadChatDrafts();
    return () => { listeners.delete(fn); };
  }, [id]);
  return text;
};
