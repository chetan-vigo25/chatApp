/**
 * App-lock suspension guard.
 *
 * The 2-step app lock (see components/AppLockGate.js) re-locks whenever the app
 * returns to the foreground after being backgrounded. Opening the system image
 * picker / camera backgrounds the app, so without this guard the lock screen
 * pops up mid-flow (e.g. while creating a status). Wrap any intentional in-app
 * activity that leaves the app with suspend/resume so that the return trip is
 * NOT treated as a re-lock trigger.
 *
 *   suspendAppLock();
 *   try { await ImagePicker.launchImageLibraryAsync(...); }
 *   finally { resumeAppLock(); }
 */
let suspended = false;
let graceUntil = 0;

export function suspendAppLock() {
  suspended = true;
}

// `delayMs` keeps the lock suspended a little past resume() so the AppState
// 'active' transition that fires when returning from the picker is still
// covered (the event arrives just before the picker promise resolves).
export function resumeAppLock(delayMs = 1200) {
  suspended = false;
  graceUntil = Date.now() + delayMs;
}

export function isAppLockSuspended() {
  return suspended || Date.now() < graceUntil;
}
