import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { chatServices } from '../../Services/Chat/Chat.Services';

// ============================================
// 📡 ASYNC THUNKS
// ============================================

// Fetch chat list
export const chatListData = createAsyncThunk(
  'chat/chatListData',
  async (searchValue, { rejectWithValue }) => {
    try {
      const response = await chatServices.chatListData(searchValue);
      const rawUser = await AsyncStorage.getItem('userInfo');
      const parsedUser = rawUser ? JSON.parse(rawUser) : null;
      const ownerUserId = parsedUser?._id || parsedUser?.id || null;
      if (!response?.data) {
        return { docs: [], ownerUserId };
      }
      const docs = response.data.docs;
      return {
        docs: Array.isArray(docs) ? docs : [],
        ownerUserId,
      };

    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// Send message
export const sendMessage = createAsyncThunk(
  'chat/sendMessage',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await chatServices.sendMessage(payload);
      return response;
 
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

// Fetch chat messages with pagination
export const chatMessage = createAsyncThunk(
  'chat/chatMessageList',
  async ({ chatId, search = '', page = 1, limit = 50 }, { rejectWithValue }) => {
    try {
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      // console.log("📡 FETCHING CHAT MESSAGES");
      // console.log("   Chat ID:", chatId);
      // console.log("   Search:", search);
      // console.log("   Page:", page);
      // console.log("   Limit:", limit);
      // console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

      const response = await chatServices.chatMessageList({
        chatId,
        search,
        page,
        limit
      });

      // console.log("✅ Chat messages response:", response);
      return response;
 
    } catch (error) {
      console.error("❌ Error fetching chat messages:", error);
      return rejectWithValue(error.message);
    }
  }
);


// Send midia upload
export const mediaUpload = createAsyncThunk(
  'chat/mediaUpload',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await chatServices.mediaUpload(payload);
      // console.log("✅ Media upload response:", response);
      return response;
 
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);
// download midia 
export const downloadMedia = createAsyncThunk(
  'chat/downloadMedia',
  async (payload, { rejectWithValue }) => {
    try {
      const response = await chatServices.downloadMedia(payload);
      return response;
 
    } catch (error) {
      return rejectWithValue(error.message);
    }
  }
);

export const mediaAllFiles = createAsyncThunk(
  'chat/mediaAllFiles',
  async (payload, { rejectWithValue }) => {
    try {
      return await chatServices.mediaAllFiles(payload || {});
    } catch (error) {
      return rejectWithValue(error.message || 'Unable to fetch media files');
    }
  }
);

export const mediaView = createAsyncThunk(
  'chat/mediaView',
  async (payload, { rejectWithValue }) => {
    try {
      return await chatServices.mediaView(payload || {});
    } catch (error) {
      return rejectWithValue(error.message || 'Unable to view media');
    }
  }
);

export const mediaDelete = createAsyncThunk(
  'chat/mediaDelete',
  async (payload, { rejectWithValue }) => {
    try {
      return await chatServices.mediaDelete(payload || {});
    } catch (error) {
      return rejectWithValue(error.message || 'Unable to delete media');
    }
  }
);

// ============================================
// 🔧 CHAT SLICE
// ============================================

const chatSlice = createSlice({
  name: 'chat',
  initialState: {
    token: null,
    chatsData: null,
    messagesData: null,
    chatMessagesData: null,
    isLoading: false,
    error: null,
    otpMessage: '',
    ownerUserId: null,
    
    // Pagination state
    currentPage: 1,
    totalPages: 1,
    hasMoreMessages: true,
  },
  reducers: {
    // Clear chat messages
    clearChatMessages: (state) => {
      state.chatMessagesData = null;
      state.currentPage = 1;
      state.totalPages = 1;
      state.hasMoreMessages = true;
    },

    // Reset pagination
    resetPagination: (state) => {
      state.currentPage = 1;
      state.totalPages = 1;
      state.hasMoreMessages = true;
    },

    // Logout
    logout: (state) => {
      state.user = null;
      state.token = null;
      state.error = null;
      state.isLoading = false;
      state.chatsData = null;
      state.messagesData = null;
      state.chatMessagesData = null;
      state.currentPage = 1;
      state.totalPages = 1;
      state.hasMoreMessages = true;
    },
  },
  extraReducers: (builder) => {
    builder
      // ============================================
      // 📋 CHAT LIST
      // ============================================
      .addCase(chatListData.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(chatListData.fulfilled, (state, action) => {
        state.isLoading = false;
        state.chatsData = action.payload?.docs || [];
        state.ownerUserId = action.payload?.ownerUserId || null;
        state.error = null;
      })
      .addCase(chatListData.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })

      // ============================================
      // 📤 SEND MESSAGE
      // ============================================
      .addCase(sendMessage.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(sendMessage.fulfilled, (state, action) => {
        state.isLoading = false;
        state.messagesData = action.payload || null;
        state.error = null;
      })
      .addCase(sendMessage.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      })
      
      // ============================================
      // 💬 CHAT MESSAGES (with pagination)
      // ============================================
      .addCase(chatMessage.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(chatMessage.fulfilled, (state, action) => {
        state.isLoading = false;
        state.chatMessagesData = action.payload || null;
        state.error = null;

        // Update pagination state
        if (action.payload?.data) {
          state.currentPage = action.payload.data.page || 1;
          state.totalPages = action.payload.data.totalPages || 1;
          state.hasMoreMessages = state.currentPage < state.totalPages;
        }
      })
      .addCase(chatMessage.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.payload;
      });
  },
});

export const { logout, clearChatMessages, resetPagination } = chatSlice.actions;
export default chatSlice.reducer;