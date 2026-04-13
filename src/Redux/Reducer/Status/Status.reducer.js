import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { statusServices } from '../../Services/Status/Status.Services';

export const createStatus = createAsyncThunk(
  'status/create',
  async (data, { rejectWithValue }) => {
    try {
      return await statusServices.createStatus(data);
    } catch (error) {
      return rejectWithValue(error);
    }
  }
);

export const fetchMyStatuses = createAsyncThunk(
  'status/fetchMy',
  async (_, { rejectWithValue }) => {
    try {
      return await statusServices.getMyStatuses();
    } catch (error) {
      return rejectWithValue(error);
    }
  }
);

export const fetchContactStatuses = createAsyncThunk(
  'status/fetchContacts',
  async (_, { rejectWithValue }) => {
    try {
      return await statusServices.getContactStatuses();
    } catch (error) {
      return rejectWithValue(error);
    }
  }
);

export const viewStatusAction = createAsyncThunk(
  'status/view',
  async (statusId, { rejectWithValue }) => {
    try {
      return await statusServices.viewStatus(statusId);
    } catch (error) {
      return rejectWithValue(error);
    }
  }
);

export const fetchStatusViewers = createAsyncThunk(
  'status/viewers',
  async (statusId, { rejectWithValue }) => {
    try {
      return await statusServices.getStatusViewers(statusId);
    } catch (error) {
      return rejectWithValue(error);
    }
  }
);

export const deleteStatusAction = createAsyncThunk(
  'status/delete',
  async (statusId, { rejectWithValue }) => {
    try {
      return await statusServices.deleteStatus(statusId);
    } catch (error) {
      return rejectWithValue(error);
    }
  }
);

const statusSlice = createSlice({
  name: 'status',
  initialState: {
    myStatuses: [],
    contactStatuses: [],
    viewers: { viewCount: 0, viewers: [] },
    isLoading: false,
    isCreating: false,
    error: null,
  },
  reducers: {
    clearStatusError: (state) => { state.error = null; },
    removeLocalStatus: (state, action) => {
      state.myStatuses = state.myStatuses.filter(s => s._id !== action.payload);
    },
    addNewStatusFromSocket: (state, action) => {
      // When socket notifies about a contact's new status
      const { userId, statusId } = action.payload;
      const existing = state.contactStatuses.find(c => String(c.userId) === String(userId));
      if (existing) {
        existing.count = (existing.count || 0) + 1;
        existing.latestAt = new Date().toISOString();
      }
    },
    removeStatusFromSocket: (state, action) => {
      const { userId, statusId } = action.payload;
      const existing = state.contactStatuses.find(c => String(c.userId) === String(userId));
      if (existing) {
        existing.statuses = (existing.statuses || []).filter(s => s._id !== statusId);
        existing.count = existing.statuses.length;
      }
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

      // Contact statuses
      .addCase(fetchContactStatuses.pending, (state) => { state.isLoading = true; })
      .addCase(fetchContactStatuses.fulfilled, (state, action) => {
        state.isLoading = false;
        state.contactStatuses = action.payload?.data || [];
      })
      .addCase(fetchContactStatuses.rejected, (state) => { state.isLoading = false; })

      // View
      .addCase(viewStatusAction.fulfilled, () => {})

      // Viewers
      .addCase(fetchStatusViewers.fulfilled, (state, action) => {
        state.viewers = action.payload?.data || { viewCount: 0, viewers: [] };
      })

      // Delete
      .addCase(deleteStatusAction.fulfilled, (state, action) => {
        // Remove from local state immediately
      })
  },
});

export const { clearStatusError, removeLocalStatus, addNewStatusFromSocket, removeStatusFromSocket } = statusSlice.actions;
export default statusSlice.reducer;
