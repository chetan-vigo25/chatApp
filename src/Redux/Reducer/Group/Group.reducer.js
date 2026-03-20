import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { groupServices } from '../../Services/Group/Group.Services';

// ============================================
// ASYNC THUNKS
// ============================================

export const createGroup = createAsyncThunk(
  'group/createGroup',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.createGroup(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const viewGroup = createAsyncThunk(
  'group/viewGroup',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.viewGroup(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const updateGroup = createAsyncThunk(
  'group/updateGroup',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.updateGroup(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const deleteGroup = createAsyncThunk(
  'group/deleteGroup',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.deleteGroup(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const exitGroup = createAsyncThunk(
  'group/exitGroup',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.exitGroup(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const transferOwnership = createAsyncThunk(
  'group/transferOwnership',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.transferOwnership(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const addMembers = createAsyncThunk(
  'group/addMembers',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.addMembers(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

export const removeMember = createAsyncThunk(
  'group/removeMember',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await groupServices.removeMember(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error?.message || error);
    }
  }
);

// ============================================
// GROUP SLICE
// ============================================

const groupSlice = createSlice({
  name: 'group',
  initialState: {
    currentGroup: null,
    isLoading: false,
    isCreating: false,
    error: null,
  },
  reducers: {
    clearCurrentGroup: (state) => {
      state.currentGroup = null;
      state.error = null;
    },
    clearGroupError: (state) => {
      state.error = null;
    },
    groupLogout: (state) => {
      state.currentGroup = null;
      state.isLoading = false;
      state.isCreating = false;
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // CREATE GROUP
      .addCase(createGroup.pending, (state) => {
        state.isCreating = true;
        state.error = null;
      })
      .addCase(createGroup.fulfilled, (state, action) => {
        state.isCreating = false;
        state.currentGroup = action.payload?.data || null;
        state.error = null;
      })
      .addCase(createGroup.rejected, (state, action) => {
        state.isCreating = false;
        state.error = action.payload;
      })

      // VIEW GROUP
      .addCase(viewGroup.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(viewGroup.fulfilled, (state, action) => {
        state.isLoading = false;
        state.currentGroup = action.payload?.data || null;
        state.error = null;
      })
      .addCase(viewGroup.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // UPDATE GROUP
      .addCase(updateGroup.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(updateGroup.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload?.data) {
          state.currentGroup = { ...state.currentGroup, ...action.payload.data };
        }
        state.error = null;
      })
      .addCase(updateGroup.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // DELETE GROUP
      .addCase(deleteGroup.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(deleteGroup.fulfilled, (state) => {
        state.isLoading = false;
        state.currentGroup = null;
      })
      .addCase(deleteGroup.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // EXIT GROUP
      .addCase(exitGroup.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(exitGroup.fulfilled, (state) => {
        state.isLoading = false;
        state.currentGroup = null;
      })
      .addCase(exitGroup.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // TRANSFER OWNERSHIP
      .addCase(transferOwnership.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(transferOwnership.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload?.data) {
          state.currentGroup = { ...state.currentGroup, ...action.payload.data };
        }
      })
      .addCase(transferOwnership.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // ADD MEMBERS
      .addCase(addMembers.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(addMembers.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload?.data) {
          state.currentGroup = { ...state.currentGroup, ...action.payload.data };
        }
      })
      .addCase(addMembers.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // REMOVE MEMBER
      .addCase(removeMember.pending, (state) => {
        state.isLoading = true;
      })
      .addCase(removeMember.fulfilled, (state, action) => {
        state.isLoading = false;
        if (action.payload?.data) {
          state.currentGroup = { ...state.currentGroup, ...action.payload.data };
        }
      })
      .addCase(removeMember.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      });
  },
});

export const { clearCurrentGroup, clearGroupError, groupLogout } = groupSlice.actions;
export default groupSlice.reducer;