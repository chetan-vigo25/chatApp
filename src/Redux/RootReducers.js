// import { combineReducers } from "@reduxjs/toolkit";
// import authSlice from '../Redux/Reducer/Auth/Auth.reducer';
// import chatSlice from '../Redux/Reducer/Chat/Chat.reducer';
// import profileSlice from '../Redux/Reducer/Profile/Profile.reducer';

// const rootReducer = combineReducers({
//     authentication: authSlice,
//     chat: chatSlice,
//     profile: profileSlice,
// });

// export default rootReducer;

import { combineReducers } from "@reduxjs/toolkit";
import authSlice from '../Redux/Reducer/Auth/Auth.reducer';
import chatSlice from '../Redux/Reducer/Chat/Chat.reducer';
import profileSlice from '../Redux/Reducer/Profile/Profile.reducer';
import groupSlice from '../Redux/Reducer/Group/Group.reducer';
import statusSlice from '../Redux/Reducer/Status/Status.reducer';
import blockSlice from '../Redux/Reducer/Block/Block.reducer';
import trackingSlice from '../Redux/Reducer/Tracking/Tracking.reducer';

const appReducer = combineReducers({
    authentication: authSlice,
    chat: chatSlice,
    profile: profileSlice,
    group: groupSlice,
    status: statusSlice,
    block: blockSlice,
    // Admin-controlled location tracking. MUST stay inside appReducer so the
    // RESET_APP_STATE wipe below returns it to initial state on logout —
    // tracking config surviving a logout would be a privacy defect.
    tracking: trackingSlice,
});

export const RESET_APP_STATE = 'app/reset_state';
export const resetAppState = () => ({ type: RESET_APP_STATE });

const rootReducer = (state, action) => {
    if (action?.type === RESET_APP_STATE) {
        return appReducer(undefined, { type: '@@INIT' });
    }
    return appReducer(state, action);
};

export default rootReducer;