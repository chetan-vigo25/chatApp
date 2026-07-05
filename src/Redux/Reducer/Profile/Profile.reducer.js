import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { profileServices } from '../../Services/Profile/Profile.Services';

// Async thunk for Profile
export const profileDetail = createAsyncThunk(
    'chat/profileDetails',
    async (id, { rejectWithValue }) => {
      try {
        const response = await profileServices.profileDetails(id);
        return response;
      } catch (error) {
        // Clean error message
        const message = error?.message || "Failed to load chat list";
        return rejectWithValue(message);
      }
    }
  );

 export const editProfile = createAsyncThunk(
   'chat/updateProfile',
   async ( playload, { rejectWithValue }) => {
     try {
       const response = await profileServices.updateProfile(playload);
       return response;
     } catch (error) {
       // Clean error message
       const message = error?.message || "Failed to load chat list";
       return rejectWithValue(message);
     }
   }
 );

 export const editImage = createAsyncThunk(
   'chat/updateImage',
   async ( formData, { rejectWithValue }) => {
     try {
       const response = await profileServices.updateImage(formData);
       console.log("update image data services response",response)
       return response;
     } catch (error) {
       // Clean error message
       const message = error?.message || "update image data services failed";
       return rejectWithValue(message);
     }
   }
 );

const profileSlice = createSlice({
  name: 'profile',
  initialState: {
    token: null,
    profileData: null,
    isBlocked: false,
    updateProfileData: null,
    messagesData: null,
    isLoading: false,
    error: null,
    otpMessage: '', // State for storing OTP message
  },
  reducers: {
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.error = null;
      state.isLoading = false;
    },
    // Set by the admin block/unblock realtime event (user:blocked / user:unblocked).
    setBlocked: (state, action) => {
      state.isBlocked = !!action.payload;
      if (state.profileData) state.profileData.isBlocked = !!action.payload;
    },
    // Set by the realtime `profile:update` event when an admin grants/revokes
    // the verified badge on THIS account (Setting.jsx badge next to own name).
    setVerified: (state, action) => {
      if (state.profileData) state.profileData.isVerified = !!action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      // Handling Profile
      .addCase(profileDetail.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(profileDetail.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.payload?.message;   // ✅ FIX
        state.profileData = action.payload?.data || null;
        state.isBlocked = !!(action.payload?.data?.isBlocked);
        state.error = null;
      })
      .addCase(profileDetail.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload; // Store error message
      })

      .addCase(editProfile.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(editProfile.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.payload?.message;   // ✅ FIX
        state.updateProfileData = action.payload || null;
        state.error = null;
      })
      .addCase(editProfile.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload; // Store error message
      })

      .addCase(editImage.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(editImage.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.payload?.message || "Profile picture updated";
      
        if (state.profileData && action.payload?.data?.profileImageUrl) {
          // ⚡ Store uploaded URL in profileImage
          state.profileData.profileImage = action.payload.data.profileImageUrl;
      
          // Optional: thumbnail if needed
          state.profileData.profileImageThumbnailUrl =
            action.payload.data.profileImageThumbnailUrl;
        }
      
        state.editedImage = action.payload || null;
        state.error = null;
      })
      .addCase(editImage.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      });

  },
});

export const { logout, setBlocked, setVerified } = profileSlice.actions;
export default profileSlice.reducer;