import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { statusServices } from '../../Services/Status/Status.Services';

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

export const viewStatusAction = createAsyncThunk(
  'status/view',
  async (statusId, { rejectWithValue }) => {
    try {
      const response = await statusServices.viewStatus(statusId);
      return { ...response, statusId };
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const reactToStatusAction = createAsyncThunk(
  'status/react',
  async ({ statusId, reactionType }, { rejectWithValue }) => {
    try {
      const response = await statusServices.reactToStatus(statusId, reactionType);
      return { ...response, statusId, reactionType };
    } catch (error) {
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
    try {
      return await statusServices.getStatusViewers(statusId);
    } catch (error) {
      return rejectWithValue(toSerializableError(error));
    }
  }
);

export const fetchStatusLikers = createAsyncThunk(
  'status/likers',
  async (statusId, { rejectWithValue }) => {
    try {
      return await statusServices.getStatusLikers(statusId);
    } catch (error) {
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

const statusSlice = createSlice({
  name: 'status',
  initialState: {
    myStatuses: [],
    /** Grouped contacts feed: [{ userId, userName, userAvatar, count, unseenCount, allViewed, latestAt, statuses[] }] */
    contactStatuses: [],
    viewers: { viewCount: 0, viewers: [] },
    likers:  { likedBy: [], total: 0 },
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
      state.myStatuses = state.myStatuses.filter(s => s._id !== action.payload);
    },

    setCurrentViewerIndex: (state, action) => {
      state.currentViewerIndex = action.payload;
    },

    clearLikeAnimation: (state) => {
      state.likeAnimationStatusId = null;
    },

    // ── Socket-driven reducers ───────────────────────────────────────────────

    /** Socket: a contact posted a new status (event: new_status) */
    addNewStatusFromSocket: (state, action) => {
      const { userId } = action.payload;
      const existing = state.contactStatuses.find(c => String(c.userId) === String(userId));
      if (existing) {
        existing.count = (existing.count || 0) + 1;
        existing.unseenCount = (existing.unseenCount || 0) + 1;
        existing.allViewed = false;
        existing.latestAt = new Date().toISOString();
      }
      // If the user isn't in the list yet, a useFocusEffect refresh will pick them up
    },

    /** Socket: a status expired or was deleted (event: status_expired / status_deleted) */
    removeStatusFromSocket: (state, action) => {
      const { statusId } = action.payload;
      // Remove from contact feed
      for (const contact of state.contactStatuses) {
        const before = (contact.statuses || []).length;
        contact.statuses = (contact.statuses || []).filter(s => s._id !== statusId);
        if (contact.statuses.length < before) {
          contact.count = contact.statuses.length;
          // Recompute unseenCount
          contact.unseenCount = contact.statuses.filter(
            s => !state.viewedStatusIds.includes(String(s._id))
          ).length;
          contact.allViewed = contact.unseenCount === 0;
        }
      }
      // Remove empty contact entries
      state.contactStatuses = state.contactStatuses.filter(c => c.count > 0);
      // Remove from myStatuses
      state.myStatuses = state.myStatuses.filter(s => s._id !== statusId);
      // Clean up reaction cache
      delete state.reactionCache[statusId];
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

    /** Seed reaction cache entry when a status is opened (data from getStatusById) */
    seedReactionCache: (state, action) => {
      const { statusId, myReaction, likeCount, dislikeCount } = action.payload;
      state.reactionCache[statusId] = { myReaction, likeCount, dislikeCount };
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
        state.contactStatuses = action.payload?.data || [];
      })
      .addCase(fetchStatusFeed.rejected, (state) => { state.isLoading = false; })

      // View — mark the status ID as viewed in local state
      .addCase(viewStatusAction.fulfilled, (state, action) => {
        const statusId = action.payload?.statusId;
        if (statusId && !state.viewedStatusIds.includes(statusId)) {
          state.viewedStatusIds.push(statusId);
        }
        // Update unseenCount in contactStatuses
        for (const contact of state.contactStatuses) {
          const found = (contact.statuses || []).find(s => String(s._id) === String(statusId));
          if (found) {
            contact.unseenCount = Math.max(0, (contact.unseenCount || 1) - 1);
            contact.allViewed = contact.unseenCount === 0;
            break;
          }
        }
      })

      // React — optimistic update
      .addCase(reactToStatusAction.fulfilled, (state, action) => {
        const { statusId, data } = action.payload || {};
        if (!statusId || !data) return;
        const { action: reactionAction, reactionType, likeCount, dislikeCount } = data;
        const cache = state.reactionCache[statusId] || {};
        state.reactionCache[statusId] = {
          ...cache,
          myReaction: reactionAction === 'removed' ? null : reactionType,
          likeCount:  likeCount  ?? cache.likeCount  ?? 0,
          dislikeCount: dislikeCount ?? cache.dislikeCount ?? 0,
        };
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
} = statusSlice.actions;

export default statusSlice.reducer;
