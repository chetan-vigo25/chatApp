import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { authServices } from '../../Services/Auth/Auth.Services';

// Async thunk for OTP generation
export const generateOtpAction = createAsyncThunk(
  'auth/generateOtp',
  // `payload` is { mobileCode, number } — the country code and national number
  // kept separate so the server can identify the exact account / VIP number.
  async (payload, { rejectWithValue }) => {
    try {
      const response = await authServices.generateOtp(payload);
      // console.log("msg test", response)
      return { otpMessage: response.otpMessage, otpData: response.otpData };
    } catch (error) {
      // A non-200 from the server rejects with the message STRING (and the
      // service has already toasted it) — a network failure rejects with an
      // Error. Keep them distinguishable so the screen can show the server's
      // explanation (e.g. a reserved VIP number / wrong country code) exactly
      // once instead of a generic retry prompt.
      const fromServer = typeof error === 'string';
      return rejectWithValue({
        message: fromServer ? error : error?.message || 'OTP generation failed',
        alreadyNotified: fromServer,
      });
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
  async (payload, { rejectWithValue }) => {
    try {
      // Same { mobileCode, number } pair as generateOtp.
      const response = await authServices.resendOtpService(payload);
      // console.log("resend otp responce",response)
      return response; // { otpMessage, otpData } — otpData carries the new OTP
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

export const emailLogin = createAsyncThunk(
  'auth/emailLogin',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await authServices.emailLoginService(payload);
      return response;
    } catch (error) {
      return rejectWithValue(error.message || error);
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
    otpData: null, // State for storing OTP data (dev)
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
        state.otpMessage = action.payload?.otpMessage || action.payload;
        state.otpData = action.payload?.otpData || null;
        state.error = null;
      })
      .addCase(generateOtpAction.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload?.message || action.payload; // Store error message
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
        state.error = action.payload?.message || action.payload; // Store error message
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
        state.error = action.payload?.message || action.payload; // Store error message
      })

      .addCase(emailLogin.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(emailLogin.fulfilled, (state, action) => {
        state.isLoading = false;
        state.user = action.payload.data || null;
        state.error = null;
      })
      .addCase(emailLogin.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      .addCase(resendOtp.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(resendOtp.fulfilled, (state, action) => {
        state.isLoading = false;
        state.otpMessage = action.payload?.otpMessage ?? action.payload;
        state.error = null;
      })
      .addCase(resendOtp.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload?.message || action.payload; // Store error message
      });


  },
});

export const { logout } = authSlice.actions;
export default authSlice.reducer;