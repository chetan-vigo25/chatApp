// Cross-module DeviceEventEmitter event names the call layer (CallProvider)
// listens to. A call push/notification, once received or actioned, is routed
// into the live call flow through these. Kept in its own module so both
// fcmService (FCM pushes) and callNotifee (notifee full-screen notifications)
// can import them without a require cycle.
export const CALL_PUSH_EVENTS = {
  INCOMING: 'call:push:incoming', // show the ringing UI (foreground / tap / wake)
  ACCEPT: 'call:push:accept',     // Accept action / tap → answer
  REJECT: 'call:push:reject',     // Decline action → reject
};

export default CALL_PUSH_EVENTS;
