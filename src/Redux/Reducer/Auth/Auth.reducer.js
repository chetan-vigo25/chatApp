import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { authServices } from '../../Services/Auth/Auth.Services';

// Async thunk for OTP generation
export const generateOtpAction = createAsyncThunk(
  'auth/generateOtp',
  async (mobile, { rejectWithValue }) => {
    try {
      const response = await authServices.generateOtp(mobile);
      // console.log("msg test", response)
      return response.otpMessage;
    } catch (error) {
      return rejectWithValue(error.message || "OTP generation failed");
    }
  }
);

export const otpVerify = createAsyncThunk(
  'auth/verifyOtpService',
  async ( payload, { rejectWithValue }) => {
    try {
      const response = await authServices.verifyOtpService(payload);
      // console.log("verify responce",response)
      // return response.otpMessage; 
      return response; 
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

export const resendOtp = createAsyncThunk(
  'auth/resendOtpService',
  async ( { fullPhoneNumber }, { rejectWithValue }) => {
    try {
      const response = await authServices.resendOtpService(fullPhoneNumber);
      // console.log("resend otp responce",response)
      return response.otpMessage; // Return the OTP message as the payload
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

export const linkedDevice = createAsyncThunk(
  'auth/activeSession',
  async (_, { rejectWithValue }) => {
    try {
      const response = await authServices.activeSession();
      // console.log("Linked session data",response)
      return response; // Return the session data on payload
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

export const removeDevice = createAsyncThunk(
  'auth/deactiveSession',
  async ( deviceId, { rejectWithValue }) => {
    try {
      const response = await authServices.deactiveSession(deviceId);
      // console.log("Removed session data",response)
      return response; // Return the session data on payload
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

const authSlice = createSlice({
  name: 'auth',
  initialState: {
    user: null,
    token: null,
    activeSessionData: null,
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
      // Handling OTP generation
      .addCase(generateOtpAction.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(generateOtpAction.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.payload; // Store OTP message
        state.error = null;
      })
      .addCase(generateOtpAction.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload; // Store error message
      })

      .addCase(otpVerify.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(otpVerify.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.message; 
        state.user = action.payload.data || null;
        state.error = null;
      })
      .addCase(otpVerify.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload; // Store error message
      })

      .addCase(linkedDevice.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(linkedDevice.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.message;
        state.activeSessionData = action.payload || null;
        state.error = null;
      })
      
      
      .addCase(linkedDevice.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload; // Store error message
      })

      .addCase(resendOtp.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(resendOtp.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.payload; 
        state.error = null;
      })
      .addCase(resendOtp.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload; // Store error message
      });


  },
});

export const { logout } = authSlice.actions;
export default authSlice.reducer;