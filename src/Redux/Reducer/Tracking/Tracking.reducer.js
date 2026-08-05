import { createSlice } from '@reduxjs/toolkit';

/**
 * Tracking slice — admin-controlled work-time location tracking (Phase 1,
 * foreground-only).
 *
 * State:
 *   enabled          — admin has tracking ON for this user (server `tracking:config`)
 *   config           — last server config {trackingTypes, intervalSec, distanceM, noticeVersion, ...}
 *   consent          — 'unknown' | 'pending' | 'granted' | 'declined'
 *   indicatorVisible — drives the persistent "tracking active" pill
 *
 * Deliberately NOT persisted anywhere: the server re-pushes `tracking:config`
 * on every connect, so a wiped app is untracked until the server says
 * otherwise. The slice lives under the root `tracking` key and is wiped by
 * RESET_APP_STATE (RootReducers resets the whole appReducer to initial state
 * on logout) — location config must never survive a logout.
 */
const initialState = {
  enabled: false,
  config: null,
  consent: 'unknown',
  indicatorVisible: false,
};

const trackingSlice = createSlice({
  name: 'tracking',
  initialState,
  reducers: {
    // Socket `tracking:config` push OR `tracking:config:request` ack.
    configReceived: (state, action) => {
      const cfg = action.payload || {};
      state.enabled = !!cfg.enabled;
      state.config = cfg;
      if (cfg.consent) state.consent = cfg.consent;
      state.indicatorVisible = !!cfg.enabled && state.consent === 'granted';
    },
    consentGranted: (state) => {
      state.consent = 'granted';
      state.indicatorVisible = state.enabled;
    },
    consentDeclined: (state) => {
      state.consent = 'declined';
      state.indicatorVisible = false;
    },
    // Admin disable push / TRACKING_DISABLED ack — stop everything, hide pill.
    stopped: (state) => {
      state.enabled = false;
      state.indicatorVisible = false;
    },
  },
});

export const { configReceived, consentGranted, consentDeclined, stopped } =
  trackingSlice.actions;
export default trackingSlice.reducer;
