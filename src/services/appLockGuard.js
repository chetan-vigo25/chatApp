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
 *
 * Suspensions NEST: an in-context permission prompt (which suspends the lock for
 * the duration of the system dialog) usually runs INSIDE a picker flow that has
 * already suspended it. The guard is therefore reference-counted — only the
 * outermost resume actually re-arms the lock, so the inner dialog can never drop
 * the outer picker's protection while the user is still browsing their gallery.
 */
let depth = 0;
let graceUntil = 0;

export function suspendAppLock() {
  depth += 1;
}

// `delayMs` keeps the lock suspended a little past the outermost resume() so the
// AppState 'active' transition that fires when returning from the picker is
// still covered (the event arrives just before the picker promise resolves).
export function resumeAppLock(delayMs = 1200) {
  depth = Math.max(0, depth - 1);
  // Extend (never shorten) the grace window: a nested resume with a long delay
  // must not be undone by an outer resume with the default one.
  graceUntil = Math.max(graceUntil, Date.now() + delayMs);
}

export function isAppLockSuspended() {
  return depth > 0 || Date.now() < graceUntil;
}
