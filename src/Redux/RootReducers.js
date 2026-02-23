import { combineReducers } from "@reduxjs/toolkit";
import authSlice from '../Redux/Reducer/Auth/Auth.reducer';
import chatSlice from '../Redux/Reducer/Chat/Chat.reducer';
import profileSlice from '../Redux/Reducer/Profile/Profile.reducer';

const rootReducer = combineReducers({
    authentication: authSlice,
    chat: chatSlice,
    profile: profileSlice,
});

export default rootReducer;