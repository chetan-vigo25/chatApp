import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { blockServices } from '../../Services/Block/Block.Services';

/**
 * Block slice — user-to-user (contact) blocking, distinct from the admin
 * account-level block tracked in the Profile slice (`profile.isBlocked`).
 *
 * State:
 *   blockedIds   — contacts *I* have blocked (hide composer, show "You blocked…")
 *   blockedByIds — contacts who have blocked *me* (disable send to them)
 *   contacts     — full list objects for the Blocked Contacts settings screen
 */

export const fetchBlockedContacts = createAsyncThunk(
  'block/fetchBlockedContacts',
  async (params, { rejectWithValue }) => {
    try {
      return await blockServices.fetchBlockedContactsApi(params || {});
    } catch (error) {
      return rejectWithValue(error?.message || error || 'Failed to load blocked contacts');
    }
  },
);

export const blockUser = createAsyncThunk(
  'block/blockUser',
  async (user, { rejectWithValue }) => {
    try {
      const userId = typeof user === 'string' ? user : user?.userId || user?._id;
      const data = await blockServices.blockUserApi(userId);
      return { ...data, user: typeof user === 'object' ? user : null };
    } catch (error) {
      return rejectWithValue(error?.message || error || 'Failed to block user');
    }
  },
);

export const unblockUser = createAsyncThunk(
  'block/unblockUser',
  async (user, { rejectWithValue }) => {
    try {
      const userId = typeof user === 'string' ? user : user?.userId || user?._id;
      const data = await blockServices.unblockUserApi(userId);
      return { ...data, userId };
    } catch (error) {
      return rejectWithValue(error?.message || error || 'Failed to unblock user');
    }
  },
);

const uniq = (arr) => [...new Set((arr || []).map((x) => String(x)))];

const blockSlice = createSlice({
  name: 'block',
  initialState: {
    blockedIds: [],
    blockedByIds: [],
    contacts: [],
    isLoading: false,
    error: null,
  },
  reducers: {
    // Hydrate from on-device SQLite cache for instant cold render.
    hydrateBlocked: (state, action) => {
      const list = action.payload || [];
      state.contacts = list;
      state.blockedIds = uniq(list.map((c) => c.userId));
    },
    // Realtime: my own device blocked someone (contact:blocked) — multi-device sync.
    contactBlocked: (state, action) => {
      const { userId } = action.payload || {};
      if (userId) state.blockedIds = uniq([...state.blockedIds, userId]);
    },
    contactUnblocked: (state, action) => {
      const { userId } = action.payload || {};
      if (userId) {
        state.blockedIds = state.blockedIds.filter((id) => id !== String(userId));
        state.contacts = state.contacts.filter((c) => String(c.userId) !== String(userId));
      }
    },
    // Realtime: someone blocked/unblocked ME (block:status:changed).
    blockedByChanged: (state, action) => {
      const { byUserId, blocked } = action.payload || {};
      if (!byUserId) return;
      if (blocked) state.blockedByIds = uniq([...state.blockedByIds, byUserId]);
      else state.blockedByIds = state.blockedByIds.filter((id) => id !== String(byUserId));
    },
    // Sync from a profile-view response (isBlocked / isBlockedBy flags).
    syncFromProfile: (state, action) => {
      const { userId, isBlocked, isBlockedBy } = action.payload || {};
      if (!userId) return;
      const id = String(userId);
      if (isBlocked) state.blockedIds = uniq([...state.blockedIds, id]);
      else state.blockedIds = state.blockedIds.filter((x) => x !== id);
      if (isBlockedBy) state.blockedByIds = uniq([...state.blockedByIds, id]);
      else state.blockedByIds = state.blockedByIds.filter((x) => x !== id);
    },
    resetBlock: (state) => {
      state.blockedIds = [];
      state.blockedByIds = [];
      state.contacts = [];
      state.error = null;
      state.isLoading = false;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(fetchBlockedContacts.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchBlockedContacts.fulfilled, (state, action) => {
        state.isLoading = false;
        const items = action.payload?.items || [];
        state.contacts = items;
        state.blockedIds = uniq(items.map((c) => c.userId));
      })
      .addCase(fetchBlockedContacts.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })
      .addCase(blockUser.fulfilled, (state, action) => {
        const userId = action.payload?.userId;
        if (userId) {
          state.blockedIds = uniq([...state.blockedIds, userId]);
          if (action.payload.user && !state.contacts.some((c) => String(c.userId) === String(userId))) {
            const u = action.payload.user;
            state.contacts.unshift({
              userId: String(userId),
              fullName: u.fullName || u.displayName || 'Unknown',
              phone: u.phone || u.mobileNumber || null,
              profileImage: u.profileImage || u.profileImageUrl || null,
              blockedAt: action.payload.blockedAt || new Date().toISOString(),
            });
          }
        }
      })
      .addCase(unblockUser.fulfilled, (state, action) => {
        const userId = action.payload?.userId;
        if (userId) {
          state.blockedIds = state.blockedIds.filter((id) => id !== String(userId));
          state.contacts = state.contacts.filter((c) => String(c.userId) !== String(userId));
        }
      });
  },
});

export const {
  hydrateBlocked,
  contactBlocked,
  contactUnblocked,
  blockedByChanged,
  syncFromProfile,
  resetBlock,
} = blockSlice.actions;
export default blockSlice.reducer;
