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

export const { logout } = profileSlice.actions;
export default profileSlice.reducer;