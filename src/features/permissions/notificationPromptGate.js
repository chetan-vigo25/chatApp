/**
 * Notification-prompt gate.
 *
 * The FCM bootstrap in App.js calls `getFCMToken()` → `requestNotificationPermission()`
 * on every cold start. That path fires the OS notification dialog *over the Splash
 * screen*, which now conflicts with the Permission Introduction screen — both Google
 * Play and Apple expect the in-app rationale to be shown BEFORE the system dialog.
 *
 * This gate lets the boot path keep doing everything it already does (fetching and
 * registering the FCM token — which does NOT need POST_NOTIFICATIONS) while holding
 * back ONLY the interactive prompt until the permission screen asks for it, or until
 * the flow decides the screen isn't needed at all.
 *
 * This is deliberately a LEAF module: it imports nothing, so both
 * `firebase/fcmService` and the permission adapters can depend on it without
 * creating an import cycle.
 */

// Held from app start. The very first thing the permission bootstrap does is either
// release it (nothing to onboard) or hand ownership to the permission screen.
let held = true;

// Safety valve: if the permission bootstrap never runs (an early crash in Splash, a
// route that bypasses it, a future refactor), the gate must NOT permanently suppress
// the notification prompt. After this window the boot path is allowed to prompt again
// exactly as it did before this feature existed.
const SAFETY_RELEASE_MS = 60 * 1000;

const safetyTimer = setTimeout(() => {
  held = false;
}, SAFETY_RELEASE_MS);

// Don't let the timer hold a Node/Jest process open (no-op on device).
if (typeof safetyTimer?.unref === 'function') safetyTimer.unref();

/**
 * @returns {boolean} true while background/boot callers must NOT show the OS
 * notification dialog. Passive status reads are always allowed.
 */
export function isNotificationPromptHeld() {
  return held;
}

/**
 * Release the gate. Called by the permission flow once it has shown its rationale
 * (or determined that no onboarding is required), after which the normal FCM
 * bootstrap may prompt again on later launches.
 */
export function releaseNotificationPrompt() {
  held = false;
  clearTimeout(safetyTimer);
}
