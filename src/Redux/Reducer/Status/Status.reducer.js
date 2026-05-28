import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { statusServices } from '../../Services/Status/Status.Services';

// ── Persisted viewed-set ────────────────────────────────────────────────────
// The server is authoritative (each /feed response stamps `isViewed`), but
// we mirror it to AsyncStorage so rings render correctly on cold open BEFORE
// the network call resolves. Without this, every restart shows green/unread
// rings for a beat — and longer offline.
const VIEWED_STORAGE_KEY = 'status:viewedStatusIds:v1';

const persistViewedIds = (ids) => {
  AsyncStorage.setItem(VIEWED_STORAGE_KEY, JSON.stringify(ids || [])).catch(() => {});
};

export const hydrateViewedStatusIds = createAsyncThunk(
  'status/hydrateViewed',
  async () => {
    try {
      const raw = await AsyncStorage.getItem(VIEWED_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
);

const toSerializableError = (error) => {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error?.message || error?.code || String(error);
};

// ── Thunks ────────────────────────────────────────────────────────────────────

export const createStatus = createAsyncThunk(
  'status/create',
  async (data, { rejectWithValue }) => {
    try {
      return await statusServices.createStatus(data);
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const fetchMyStatuses = createAsyncThunk(
  'status/fetchMy',
  async (_, { rejectWithValue }) => {
    try {
      return await statusServices.getMyStatuses();
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

/** Feed — replaces fetchContactStatuses; returns grouped contacts array */
export const fetchStatusFeed = createAsyncThunk(
  'status/fetchFeed',
  async (_, { rejectWithValue }) => {
    try {
      return await statusServices.getStatusFeed();
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

// Legacy alias kept so existing code doesn't break
export const fetchContactStatuses = fetchStatusFeed;

/**
 * Pull the public status settings (max sizes, max video secs, expiry hours,
 * etc.). Called on app boot and whenever the user opens the Status create
 * flow — keeps client-side validation in sync with the admin-controlled
 * settings row. Backend always returns sane defaults, so this thunk never
 * rejects on a missing settings row.
 */
export const fetchStatusSettings = createAsyncThunk(
  'status/fetchSettings',
  async (_, { rejectWithValue }) => {
    try {
      const response = await statusServices.getStatusSettings();
      return response?.data || null;
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const viewStatusAction = createAsyncThunk(
  'status/view',
  async (statusId, { rejectWithValue }) => {
    const startedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[status/view] → start statusId=${statusId} at ${new Date(startedAt).toISOString()}`);
    try {
      const response = await statusServices.viewStatus(statusId);
      // eslint-disable-next-line no-console
      console.log(`[status/view] ✓ ok    statusId=${statusId} took ${Date.now() - startedAt}ms`);
      return { ...response, statusId };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(
        `[status/view] ✗ fail  statusId=${statusId} took ${Date.now() - startedAt}ms ` +
        `error=${error?.message || error?.code || String(error)}`
      );
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const reactToStatusAction = createAsyncThunk(
  'status/react',
  async ({ statusId, reactionType }, { rejectWithValue }) => {
    const startedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(
      `[status/react] → start statusId=${statusId} type=${reactionType} ` +
      `at ${new Date(startedAt).toISOString()}`
    );
    try {
      const response = await statusServices.reactToStatus(statusId, reactionType);
      const took = Date.now() - startedAt;
      const data = response?.data || {};
      // eslint-disable-next-line no-console
      console.log(
        `[status/react] ✓ ok    statusId=${statusId} type=${reactionType} took ${took}ms ` +
        `myReaction=${data.myReaction} likes=${data.likeCount} dislikes=${data.dislikeCount}`
      );
      return { ...response, statusId, reactionType };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(
        `[status/react] ✗ fail  statusId=${statusId} type=${reactionType} took ${Date.now() - startedAt}ms ` +
        `error=${error?.message || error?.code || String(error)}`
      );
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const replyToStatusAction = createAsyncThunk(
  'status/reply',
  async ({ statusId, message }, { rejectWithValue }) => {
    try {
      return await statusServices.replyToStatus(statusId, message);
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const reportStatusAction = createAsyncThunk(
  'status/report',
  async ({ statusId, reason, details }, { rejectWithValue }) => {
    try {
      return await statusServices.reportStatus(statusId, reason, details);
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const hideStatusAction = createAsyncThunk(
  'status/hide',
  async (statusId, { rejectWithValue }) => {
    try {
      await statusServices.hideStatus(statusId);
      return { statusId };
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const shareStatusAction = createAsyncThunk(
  'status/share',
  async ({ statusId, targetChatIds }, { rejectWithValue }) => {
    try {
      return await statusServices.shareStatus(statusId, targetChatIds);
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const fetchStatusViewers = createAsyncThunk(
  'status/viewers',
  async (statusId, { rejectWithValue }) => {
    const startedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[status/viewers] → fetch list statusId=${statusId} at ${new Date(startedAt).toISOString()}`);
    try {
      const res = await statusServices.getStatusViewers(statusId);
      const count = res?.data?.viewers?.length ?? 0;
      const total = res?.data?.viewCount ?? 0;
      // eslint-disable-next-line no-console
      console.log("res?. view", res?.data)
      console.log(`[status/viewers] ✓ ok statusId=${statusId} took ${Date.now() - startedAt}ms viewers=${count} total=${total}`);
      return res;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(`[status/viewers] ✗ fail statusId=${statusId} took ${Date.now() - startedAt}ms error=${error?.message || String(error)}`);
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const fetchStatusLikers = createAsyncThunk(
  'status/likers',
  async (statusId, { rejectWithValue }) => {
    const startedAt = Date.now();
    // eslint-disable-next-line no-console
    console.log(`[status/likers] → fetch list statusId=${statusId} at ${new Date(startedAt).toISOString()}`);
    try {
      const res = await statusServices.getStatusLikers(statusId);
      const total = res?.data?.total ?? res?.data?.likedBy?.length ?? 0;
      // eslint-disable-next-line no-console
      console.log("res?.likes ", res?.data)

      console.log(`[status/likers] ✓ ok statusId=${statusId} took ${Date.now() - startedAt}ms likes=${total}`);
      return res;
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log(`[status/likers] ✗ fail statusId=${statusId} took ${Date.now() - startedAt}ms error=${error?.message || String(error)}`);
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const deleteStatusAction = createAsyncThunk(
  'status/delete',
  async (statusId, { rejectWithValue }) => {
    try {
      return await statusServices.deleteStatus(statusId);
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

// ── Slice ─────────────────────────────────────────────────────────────────────

// Defaults match the backend's STATUS_PUBLIC_SETTINGS_DEFAULTS — used until
// the real values are fetched so the UI never reads `undefined` limits.
const DEFAULT_STATUS_SETTINGS = {
  STATUS_DURATION_HOURS:         24,
  STATUS_MAX_VIDEO_SECS:         60,
  STATUS_MAX_IMAGE_SIZE_MB:      10,
  STATUS_MAX_VIDEO_SIZE_MB:      50,
  STATUS_ALLOW_DOWNLOAD_DEFAULT: true,
};

const statusSlice = createSlice({
  name: 'status',
  initialState: {
    myStatuses: [],
    /** Grouped contacts feed: [{ userId, userName, userAvatar, count, unseenCount, allViewed, latestAt, statuses[] }] */
    contactStatuses: [],
    viewers: { viewCount: 0, viewers: [] },
    likers:  { likedBy: [], total: 0 },
    /** Dynamic limits/flags from backend — drives all upload validation. */
    settings: DEFAULT_STATUS_SETTINGS,
    settingsFetchedAt: 0,
    /** Set of status IDs the current user has already viewed (persisted for ring rendering) */
    viewedStatusIds: [],
    /**
     * Local reaction cache: { [statusId]: { myReaction: 'like'|'dislike'|null, likeCount, dislikeCount } }
     * Populated from server on view; updated optimistically on react.
     */
    reactionCache: {},
    /** StatusId currently showing a floating-heart animation (from socket status_like_animation). Null = none. */
    likeAnimationStatusId: null,
    /** Index of the slide currently visible in StatusViewer */
    currentViewerIndex: 0,
    isLoading: false,
    isCreating: false,
    error: null,
  },
  reducers: {
    clearStatusError: (state) => { state.error = null; },

    removeLocalStatus: (state, action) => {
      const id = String(action.payload);
      state.myStatuses = state.myStatuses.filter(s => String(s._id) !== id);
    },

    /**
     * Optimistic local toggle of a reaction. Dispatched before the network
     * call so the UI flips instantly; the .fulfilled/.rejected handlers
     * reconcile or roll back below.
     */
    optimisticReact: (state, action) => {
      const { statusId, reactionType } = action.payload || {};
      if (!statusId || !reactionType) return;
      const id = String(statusId);
      const prev = state.reactionCache[id] || { myReaction: null, likeCount: 0, dislikeCount: 0 };
      const next = { ...prev };
      const wasSame = prev.myReaction === reactionType;

      // Adjust counts based on transition
      if (prev.myReaction === 'like')    next.likeCount    = Math.max(0, (prev.likeCount    || 0) - 1);
      if (prev.myReaction === 'dislike') next.dislikeCount = Math.max(0, (prev.dislikeCount || 0) - 1);
      if (!wasSame) {
        if (reactionType === 'like')    next.likeCount    = (next.likeCount    || 0) + 1;
        if (reactionType === 'dislike') next.dislikeCount = (next.dislikeCount || 0) + 1;
      }
      next.myReaction = wasSame ? null : reactionType;
      next._previous = prev; // stash for rollback
      state.reactionCache[id] = next;
    },

    setCurrentViewerIndex: (state, action) => {
      state.currentViewerIndex = action.payload;
    },

    clearLikeAnimation: (state) => {
      state.likeAnimationStatusId = null;
    },

    // ── Socket-driven reducers ───────────────────────────────────────────────

    /**
     * Socket: a contact posted a new status (event: `status:new`).
     *
     * Backend payload (see _notifyContactsStatusCreated):
     *   { statusId, ownerId, ownerName, ownerAvatar, ownerMobile, ownerPhone,
     *     mediaType, thumbnailUrl, expiresAt, createdAt, visibility, status }
     *
     * Reducer responsibilities:
     *   1. If the owner already has an entry → push the new status into their
     *      `statuses` array (so the ring/thumb updates), bump counters, and
     *      mark unseen.
     *   2. If the owner is brand-new in this viewer's feed → insert a new
     *      entry at the top of `contactStatuses` so the ring appears
     *      immediately, no refresh required.
     *
     * Also dedupes by statusId so a duplicate fan-out (e.g. socket reconnect
     * replay) doesn't double-count.
     */
    addNewStatusFromSocket: (state, action) => {
      const p = action.payload || {};
      const ownerId  = String(p.ownerId || p.userId || '');
      const statusId = String(p.statusId || p.status?._id || '');
      if (!ownerId || !statusId) return;

      // (Backend excludes the owner from broadcast recipients, so no self-check needed here.)

      // Build a minimal status object from the broadcast snapshot so the
      // ring/thumb can render without an extra round-trip.
      const snap = p.status || {};
      const firstSnapMedia = (snap.mediaItems || [])[0];
      const newStatus = {
        _id:          statusId,
        ownerId,
        createdAt:    snap.createdAt   || p.createdAt   || new Date().toISOString(),
        expiresAt:    snap.expiresAt   || p.expiresAt   || null,
        caption:      snap.caption     || null,
        textContent:  snap.textContent || null,
        bgColor:      snap.bgColor     || null,
        mediaItems:   snap.mediaItems  || (p.mediaType ? [{
          mediaType:    p.mediaType,
          mediaUrl:     null,
          thumbnailUrl: p.thumbnailUrl || null,
          order:        0,
        }] : []),
        myReaction:   null,
      };

      const existing = state.contactStatuses.find(c => String(c.userId) === ownerId);
      const nowIso   = new Date().toISOString();

      if (existing) {
        // Dedup: if we already have this statusId, do nothing
        if ((existing.statuses || []).some(s => String(s._id) === statusId)) return;

        existing.statuses   = [...(existing.statuses || []), newStatus];
        existing.count      = existing.statuses.length;
        existing.unseenCount = (existing.unseenCount || 0) + 1;
        existing.allViewed  = false;
        existing.latestAt   = newStatus.createdAt || nowIso;
      } else {
        // Brand-new contact in this viewer's feed — insert at the top so the
        // ring is visible immediately. Display name follows the same priority
        // the rest of the UI uses (saved name will be re-resolved client-side
        // via useContactDirectory when rendered).
        state.contactStatuses.unshift({
          userId:         ownerId,
          name:           p.ownerName   || p.ownerPhone || 'Unknown',
          avatar:         p.ownerAvatar || null,
          phone:          p.ownerPhone  || null,
          mobile:         p.ownerMobile || null,
          isSavedContact: false,
          statuses:       [newStatus],
          count:          1,
          unseenCount:    1,
          allViewed:      false,
          latestAt:       newStatus.createdAt || nowIso,
        });
      }

      // Re-sort: unseen-first, most-recent first (matches /feed sort order)
      state.contactStatuses.sort((a, b) => {
        if (a.allViewed !== b.allViewed) return a.allViewed ? 1 : -1;
        return new Date(b.latestAt || 0) - new Date(a.latestAt || 0);
      });
    },

    /** Socket: a status expired or was deleted (event: status_expired / status_deleted) */
    removeStatusFromSocket: (state, action) => {
      const id = String(action.payload?.statusId || '');
      if (!id) return;
      // Remove from contact feed
      for (const contact of state.contactStatuses) {
        const before = (contact.statuses || []).length;
        contact.statuses = (contact.statuses || []).filter(s => String(s._id) !== id);
        if (contact.statuses.length < before) {
          contact.count = contact.statuses.length;
          contact.unseenCount = contact.statuses.filter(
            s => !state.viewedStatusIds.includes(String(s._id))
          ).length;
          contact.allViewed = contact.unseenCount === 0;
        }
      }
      // Remove empty contact entries
      state.contactStatuses = state.contactStatuses.filter(c => c.count > 0);
      // Remove from myStatuses
      state.myStatuses = state.myStatuses.filter(s => String(s._id) !== id);
      // Clean up reaction cache
      delete state.reactionCache[id];
    },

    /** Socket: someone liked/reacted to my status (event: status_reaction_update) */
    handleReactionUpdateFromSocket: (state, action) => {
      const { statusId, likeCount, dislikeCount } = action.payload;
      if (state.reactionCache[statusId]) {
        state.reactionCache[statusId].likeCount = likeCount;
        state.reactionCache[statusId].dislikeCount = dislikeCount;
      }
      // Update myStatuses entry if present
      const mine = state.myStatuses.find(s => String(s._id) === String(statusId));
      if (mine) {
        mine.likeCount = likeCount;
        mine.dislikeCount = dislikeCount;
      }
    },

    /** Socket: floating hearts animation trigger (event: status_like_animation) */
    triggerLikeAnimation: (state, action) => {
      state.likeAnimationStatusId = action.payload.statusId;
    },

    /**
     * Seed reaction cache entry when a status is opened.
     *
     * NEVER overwrites an existing `myReaction` — once the user has reacted
     * in-session, that local truth wins over whatever the (possibly stale)
     * feed payload reports. Counts ARE refreshed since the server is the
     * authority on those.
     *
     * Also normalises statusId to String() to stay consistent with the rest
     * of the slice (reactToStatusAction.fulfilled, optimisticReact, etc.).
     */
    seedReactionCache: (state, action) => {
      const { statusId, myReaction, likeCount, dislikeCount } = action.payload || {};
      if (!statusId) return;
      const id = String(statusId);
      const existing = state.reactionCache[id];
      state.reactionCache[id] = {
        // Preserve local reaction if we already have one for this status.
        // The seed is allowed to fill in `myReaction` only when nothing is
        // there yet, OR when the server explicitly tells us the user has
        // reacted (truthy) — never demote a known like to null on a stale
        // seed.
        myReaction:
          existing?.myReaction !== undefined && existing?.myReaction !== null
            ? existing.myReaction
            : (myReaction || null),
        likeCount:    likeCount    ?? existing?.likeCount    ?? 0,
        dislikeCount: dislikeCount ?? existing?.dislikeCount ?? 0,
      };
    },
  },
  extraReducers: (builder) => {
    builder
      // Create
      .addCase(createStatus.pending, (state) => { state.isCreating = true; state.error = null; })
      .addCase(createStatus.fulfilled, (state, action) => {
        state.isCreating = false;
        const newStatus = action.payload?.data;
        if (newStatus) state.myStatuses.unshift(newStatus);
      })
      .addCase(createStatus.rejected, (state, action) => { state.isCreating = false; state.error = action.payload; })

      // My statuses
      .addCase(fetchMyStatuses.pending, (state) => { state.isLoading = true; })
      .addCase(fetchMyStatuses.fulfilled, (state, action) => {
        state.isLoading = false;
        state.myStatuses = action.payload?.data || [];
      })
      .addCase(fetchMyStatuses.rejected, (state) => { state.isLoading = false; })

      // Feed (contacts grouped)
      .addCase(fetchStatusFeed.pending, (state) => { state.isLoading = true; })
      .addCase(fetchStatusFeed.fulfilled, (state, action) => {
        state.isLoading = false;
        const data = action.payload?.data || [];
        state.contactStatuses = data;

        // Rehydrate the viewed-set from each status's server-stamped `isViewed`
        // flag. We MERGE rather than replace — local optimistic views (from
        // viewStatusAction) shouldn't be dropped just because they haven't
        // been synced to the server's view-set yet.
        const merged = new Set(state.viewedStatusIds.map(String));
        for (const contact of data) {
          for (const s of (contact.statuses || [])) {
            if (s && s.isViewed === true && s._id) {
              merged.add(String(s._id));
            }
          }
        }
        state.viewedStatusIds = Array.from(merged);
        persistViewedIds(state.viewedStatusIds);

        // Recompute per-contact unseen counters using the merged set so the
        // ring colour is consistent with what we just hydrated.
        for (const contact of state.contactStatuses) {
          contact.unseenCount = (contact.statuses || []).filter(
            s => !merged.has(String(s._id))
          ).length;
          contact.allViewed = contact.unseenCount === 0;
        }
      })
      .addCase(fetchStatusFeed.rejected, (state) => { state.isLoading = false; })

      // Hydrate viewed-set from AsyncStorage on app boot (before any /feed call)
      .addCase(hydrateViewedStatusIds.fulfilled, (state, action) => {
        const stored = Array.isArray(action.payload) ? action.payload.map(String) : [];
        if (stored.length === 0) return;
        const merged = new Set([...state.viewedStatusIds.map(String), ...stored]);
        state.viewedStatusIds = Array.from(merged);
      })

      // View — mark the status ID as viewed in local state
      .addCase(viewStatusAction.fulfilled, (state, action) => {
        // Always normalize to String — viewedStatusIds is read everywhere as String(),
        // so storing the raw ObjectId here would break dedup on subsequent views.
        const statusId = action.payload?.statusId ? String(action.payload.statusId) : null;
        if (statusId && !state.viewedStatusIds.includes(statusId)) {
          state.viewedStatusIds.push(statusId);
          persistViewedIds(state.viewedStatusIds);
        }
        // Update unseenCount in contactStatuses
        for (const contact of state.contactStatuses) {
          const found = (contact.statuses || []).find(s => String(s._id) === statusId);
          if (found) {
            contact.unseenCount = Math.max(0, (contact.unseenCount || 1) - 1);
            contact.allViewed = contact.unseenCount === 0;
            break;
          }
        }
      })

      // React — reconcile with the server's canonical counts on success,
      // roll back the optimistic toggle on failure.
      //
      // Backend response shape: { likeCount, dislikeCount, myReaction }
      // (NOT { action, reactionType, ... } — that older shape was a stale
      // assumption that overwrote the optimistic flip with `undefined`,
      // which is why the heart never turned red even though the count
      // ticked up.)
      .addCase(reactToStatusAction.fulfilled, (state, action) => {
        const { statusId, data } = action.payload || {};
        if (!statusId || !data) return;
        const id = String(statusId);
        const cache = state.reactionCache[id] || {};
        state.reactionCache[id] = {
          myReaction:   data.myReaction !== undefined
            ? data.myReaction
            : cache.myReaction ?? null,
          likeCount:    data.likeCount    ?? cache.likeCount    ?? 0,
          dislikeCount: data.dislikeCount ?? cache.dislikeCount ?? 0,
        };
      })
      .addCase(reactToStatusAction.rejected, (state, action) => {
        const id = String(action.meta?.arg?.statusId || '');
        const cache = id && state.reactionCache[id];
        if (cache && cache._previous) {
          // Restore the snapshot captured by `optimisticReact`.
          state.reactionCache[id] = cache._previous;
        }
      })

      // Settings — hydrate dynamic limits used by upload validators.
      .addCase(fetchStatusSettings.fulfilled, (state, action) => {
        if (action.payload) {
          state.settings = { ...DEFAULT_STATUS_SETTINGS, ...action.payload };
          state.settingsFetchedAt = Date.now();
        }
      })

      // Hide — remove contact from feed
      .addCase(hideStatusAction.fulfilled, (state, action) => {
        const { statusId } = action.payload || {};
        if (!statusId) return;
        for (const contact of state.contactStatuses) {
          contact.statuses = (contact.statuses || []).filter(s => s._id !== statusId);
          contact.count = contact.statuses.length;
        }
        state.contactStatuses = state.contactStatuses.filter(c => c.count > 0);
      })

      // Viewers
      .addCase(fetchStatusViewers.fulfilled, (state, action) => {
        state.viewers = action.payload?.data || { viewCount: 0, viewers: [] };
      })

      // Likers
      .addCase(fetchStatusLikers.fulfilled, (state, action) => {
        state.likers = action.payload?.data || { likedBy: [], total: 0 };
      })

      // Delete (local list updated via removeLocalStatus or removeStatusFromSocket)
      .addCase(deleteStatusAction.fulfilled, () => {})
  },
});

export const {
  clearStatusError,
  removeLocalStatus,
  setCurrentViewerIndex,
  clearLikeAnimation,
  addNewStatusFromSocket,
  removeStatusFromSocket,
  handleReactionUpdateFromSocket,
  triggerLikeAnimation,
  seedReactionCache,
  optimisticReact,
} = statusSlice.actions;

export default statusSlice.reducer;
