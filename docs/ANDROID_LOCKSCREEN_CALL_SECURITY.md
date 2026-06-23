# Android Lock-Screen Call Security (WhatsApp-style)

How to answer a call from the lock screen **without** exposing the rest of the app.
This documents the complete, working implementation so it can be reproduced exactly
in a fresh codebase.

---

## 1. The problem

This is a **single-Activity React Native (Expo) app** — the entire UI (every chat,
screen, and the call overlay) lives inside one `MainActivity`.

To make an incoming call appear over the lock screen, the app sets these **static**
attributes on `MainActivity` (via a config plugin):

```xml
android:showWhenLocked="true"
android:turnScreenOn="true"
```

That flag is what lets the full-screen-intent call notification draw over the
keyguard. **But because it's permanent and applies to the whole Activity, once the
call shows over the lock screen the WHOLE app is shown over the lock screen.** After
answering, pressing Back (or minimizing) revealed the app behind the call — fully
navigable (chats, messages, settings) with **no unlock required**. That's the
security hole.

### Why WhatsApp doesn't have this
WhatsApp uses a **dedicated, separate call Activity** that carries `showWhenLocked`.
Its main app activities do **not**. So when the call ends or you back out while
locked, the isolated call activity finishes and the keyguard reasserts — the main
app can never draw over the lock screen.

A single-Activity RN app can't split activities the same way, so we **emulate that
isolation dynamically**: keep the manifest flag for the first over-keyguard display,
then **revoke it at runtime** the moment the user leaves the call, and **push the app
behind the keyguard**.

---

## 2. The Android APIs used

| API | Purpose |
|---|---|
| `KeyguardManager.isKeyguardLocked()` | At call arrival, record whether the device was locked. Only locked calls get the restrictions. |
| `Activity.setShowWhenLocked(boolean)` (API 27+) | **Runtime** override of the manifest `android:showWhenLocked`. Set `false` to revoke. |
| `Activity.setTurnScreenOn(boolean)` (API 27+) | Undo the wake flag. |
| `Activity.moveTaskToBack(true)` | With `showWhenLocked` now false and the device locked, sending the task to back reveals the keyguard. |
| Block Back / minimize while a locked call is active | The app is never revealed; Back routes to "return to lock". |

> Do **NOT** use `KeyguardManager.requestDismissKeyguard()` here — it prompts an
> unlock to *enter* the app, the opposite of what we want.

---

## 3. Architecture (5 layers)

```
Incoming call (locked device)
   │
   ▼
[1] Native: KeyguardManager.isKeyguardLocked() → record "this call began locked"
   │
   ▼
[2] Manifest (config plugin): showWhenLocked=true  →  call draws OVER the keyguard
   │
   ▼
[3] CallProvider (JS): lockedCallRef = true; lockedCall state = true
   │
   ▼  user presses Back / ends / declines the call
   │
[4] CallOverlay (JS): back → leaveToLock()  (minimize is disabled while locked)
   │
   ▼
[5] Native: setShowWhenLocked(false) + moveTaskToBack(true)  →  system LOCK SCREEN returns
```

---

## 4. Implementation

### 4.1 Native module — `modules/expo-call-ui/.../ExpoCallUiModule.kt`

Add the import:

```kotlin
import android.app.KeyguardManager
```

Add these three `Function`s inside `ModuleDefinition { ... }`:

```kotlin
// ---- lock-screen security (WhatsApp-style isolation) ----

// True when the device is currently locked (keyguard showing). Recorded at call
// arrival so we only apply locked-call restrictions to calls that began locked.
Function("isDeviceLocked") {
  val ctx = appContext.reactContext ?: return@Function false
  val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
  km?.isKeyguardLocked ?: false
}

// Runtime override of the manifest android:showWhenLocked. We keep the manifest
// flag true so the call reliably appears OVER the keyguard on launch, then revoke
// it at runtime (show=false) the moment the user leaves the call, so the rest of
// the app can never be drawn over the lock screen.
Function("setShowWhenLocked") { show: Boolean ->
  val activity = appContext.currentActivity
  activity?.runOnUiThread {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(show)
      activity.setTurnScreenOn(show)
    }
  }
  Unit               // IMPORTANT: explicit Unit — a bare `return@Function` here
                     // breaks Kotlin's return-type inference for the Function DSL.
}

// Send the app BEHIND the keyguard: revoke show-when-locked, then move the task to
// back so the system lock screen reasserts. Called when a call that started on a
// locked device ends or the user backs out of it — user lands on the lock screen.
Function("returnToLockScreen") {
  val activity = appContext.currentActivity
  activity?.runOnUiThread {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      activity.setShowWhenLocked(false)
      activity.setTurnScreenOn(false)
    }
    activity.moveTaskToBack(true)
  }
  Unit
}
```

> **Gotcha:** in the Expo Modules Kotlin DSL, a `Function { ... }` body that uses
> `val x = something ?: return@Function` fails to compile with
> *"Return type mismatch: expected 'Any?', actual 'Unit'"*. Use a null-safe call
> (`activity?.runOnUiThread { ... }`) and end the lambda with an explicit `Unit`.

#### 4.1a — CRITICAL: re-arm `showWhenLocked=true` when displaying an incoming call

`returnToLockScreen()` sets `showWhenLocked=false` at runtime to re-protect the app.
That runtime value **persists on the (backgrounded) Activity instance**. If the app
is NOT killed between calls, the *next* incoming call's full-screen intent lights the
screen but the call UI **cannot draw over the keyguard** — the exact "screen turns on
but no call UI" bug.

**Fix:** at the top of the native `display(...)` (the incoming-call notification
builder in `ExpoCallUiModule.kt`), re-arm the flag before posting the notification:

```kotlin
private fun display(ctx: Context, options: Map<String, Any?>) {
  // ...read callId/name/type...
  val isVideo = callType == "video"

  // Re-arm show-when-locked TRUE on the (possibly backgrounded) activity. A prior
  // locked call's returnToLockScreen() set it FALSE to re-protect the app; without
  // resetting it here, the full-screen intent for THIS new call would light the
  // screen but the call UI couldn't draw over the keyguard ("screen on, no UI").
  // When the app is killed there's no activity → the manifest flag handles it.
  appContext.currentActivity?.let { act ->
    act.runOnUiThread {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        act.setShowWhenLocked(true)
        act.setTurnScreenOn(true)
      }
    }
  }

  ensureChannel(ctx)
  // ...build + post the CallStyle full-screen notification...
}
```

### 4.2 Native module TS API — `modules/expo-call-ui/index.ts`

```ts
// ---- lock-screen security ----
// True when the device is currently locked. Android only; false on iOS / Expo Go.
export const isDeviceLocked = (): boolean => !!Native?.isDeviceLocked?.();

// Runtime override of show-when-locked on the current activity.
export const setShowWhenLocked = (show: boolean): void => {
  Native?.setShowWhenLocked?.(show);
};

// Revoke show-when-locked + move the app behind the keyguard so the system lock
// screen reasserts (used when a locked-device call ends / the user leaves it).
export const returnToLockScreen = (): void => {
  Native?.returnToLockScreen?.();
};
```

### 4.3 Manifest — `plugins/withCallFullScreen.js` (KEEP AS-IS)

Leave the static manifest flags in place — they are required so the call appears
over the keyguard on the **first** display. The runtime `setShowWhenLocked(false)`
overrides them when we re-lock.

```js
// inside withAndroidManifest:
if (mainActivity) {
  mainActivity.$['android:showWhenLocked'] = 'true';
  mainActivity.$['android:turnScreenOn'] = 'true';
}
// plus the USE_FULL_SCREEN_INTENT permission.
```

### 4.4 JS wrappers (gated, crash-safe) — `src/firebase/callNotifee.js`

`isCallUi()` resolves the native module via `requireOptionalNativeModule('ExpoCallUi')`
and returns true only on Android with the module present, so these no-op everywhere
else (iOS / Expo Go).

```js
// ===== lock-screen security (Android) =====
// Is the device locked right now? Recorded when a call arrives so we only apply
// locked-call restrictions to calls that began on a locked device.
export const isDeviceLockedNow = () => {
  if (!isCallUi()) return false;
  try { return !!getCallUi().isDeviceLocked(); } catch (_) { return false; }
};

// Send the app behind the keyguard so the system lock screen reasserts.
export const returnToLockScreen = () => {
  if (!isCallUi()) return;
  try { getCallUi().returnToLockScreen(); } catch (_) { /* best-effort */ }
};
```

### 4.5 Call state wiring — `src/calls/CallProvider.jsx`

**Import:**
```js
import {
  /* ...existing... */
  isDeviceLockedNow, returnToLockScreen,
} from '../firebase/callNotifee';
```

**State/ref (near the other refs):**
```jsx
// Lock-screen security: true when the current call ARRIVED while the device was
// locked. Such a call shows over the keyguard but the app behind it must stay
// protected — back/end returns to the lock screen instead of revealing the app.
const lockedCallRef = useRef(false);
const [lockedCall, setLockedCall] = useState(false);
```

**Record the lock state when a call arrives** (inside `onSignalIncoming`, right
after `startRinging('incoming')`):
```js
const locked = isDeviceLockedNow();
lockedCallRef.current = locked;
setLockedCall(locked);
```

**Return to the lock screen when a locked-device call ends** (inside `finalizeEnd`,
in the reset timeout):
```js
resetTimerRef.current = setTimeout(() => {
  endedRef.current = false;
  // If this call began on a locked device, drop the app BEHIND the keyguard now
  // that it's over — the user lands on the lock screen, never the app.
  if (lockedCallRef.current) {
    returnToLockScreen();
    lockedCallRef.current = false;
    setLockedCall(false);
  }
  dispatch({ type: ACT.RESET });
}, 500);
```

**Expose a leave-to-lock action + the flag** (define near `minimize`/`maximize`):
```jsx
// Leave the call UI while the device is locked → return to the system lock screen
// (NOT the app). The call keeps running in the background (the ongoing-call
// notification brings it back) but the app stays protected.
const leaveToLock = useCallback(() => {
  returnToLockScreen();
}, []);
```

**Add to the context `value` object:**
```js
const value = {
  /* ...existing... */
  lockedCall,
  leaveToLock,
};
```

### 4.6 Call UI wiring — `src/calls/screens/CallOverlay.jsx`

**Destructure the new context values:**
```jsx
const {
  /* ...existing... */
  lockedCall, leaveToLock,
} = useCall();
```

**Disable minimize while locked** (minimizing would reveal the app):
```jsx
// Minimizing reveals the app behind the call — forbidden when the call arrived on
// a LOCKED device. In that case there is no minimize affordance; leaving the call
// returns to the lock screen.
const canMinimize = (status === CALL_STATUS.ACTIVE || accepted || status === CALL_STATUS.OUTGOING)
  && !lockedCall;
```

**Back button → return to lock screen while locked:**
```jsx
const sub = BackHandler.addEventListener('hardwareBackPress', () => {
  // Call arrived on a locked device → back returns to the system lock screen,
  // never the app. The call keeps running (ongoing notification brings it back).
  if (lockedCall) { leaveToLock(); return true; }
  if (canMinimize) minimize();
  return true;
});
return () => sub.remove();
}, [visible, minimized, incomingCollapsed, canMinimize, minimize, lockedCall, leaveToLock]);
```

---

## 5. Behavior matrix

| Scenario | Result |
|---|---|
| Unlocked call (any) | Normal behavior — no restrictions applied |
| Incoming call while locked | Shows full-screen over the keyguard |
| Answer from lock screen | Works; only the call UI is visible |
| Back during a locked call | Returns to the **system lock screen**; call keeps running |
| End / decline / hang up while locked | Returns to the lock screen |
| Minimize during a locked call | Disabled (no affordance) |
| App screens / chats while locked | **Inaccessible** — keyguard required |
| iOS / Expo Go | All native calls no-op → unchanged behavior |

---

## 6. Build & test

This includes **native (Kotlin)** changes, so a JS reload is NOT enough:

```bash
npx expo run:android
```

If `android/` was generated before the module changes, run a prebuild first:
```bash
npx expo prebuild -p android
npx expo run:android
```

**Test matrix (real device, with a secure PIN/biometric lock):**
- [ ] Lock device → receive voice call → answer → press Back → lands on lock screen, app NOT accessible
- [ ] Same for video call
- [ ] Lock → answer → End call → lands on lock screen
- [ ] Lock → decline incoming → lands on lock screen
- [ ] Lock → answer → press Home → tap ongoing-call notification → returns to call (still protected)
- [ ] **Unlocked** call → answer → minimize/back works normally (no regression)
- [ ] After returning to lock, unlocking the device shows the app normally

---

## 7. Notes & gotchas

- **Keep the manifest `showWhenLocked`/`turnScreenOn`.** Removing them breaks the
  first over-keyguard display. The runtime `setShowWhenLocked(false)` overrides them.
- **Secure lock required for real protection.** On a *Swipe* (insecure) keyguard,
  "locked" is cosmetic — `moveTaskToBack` still returns to the swipe screen, but a
  swipe re-enters. This is an Android-wide limitation, not a code issue. Test with a
  real PIN/fingerprint.
- **The call keeps running** after `returnToLockScreen()` (we `moveTaskToBack`, we do
  NOT finish the activity). The ongoing-call foreground-service notification brings
  it back. If you'd rather fully end the call on Back, call `hangup()` before
  `leaveToLock()`.
- **API level:** `setShowWhenLocked`/`setTurnScreenOn` are API 27+ (guarded with
  `Build.VERSION.SDK_INT >= O_MR1`). `isKeyguardLocked`/`moveTaskToBack` work on all
  supported versions.
- **iOS** is unaffected — every native call is gated to Android (`isCallUi()`), and
  iOS lock-screen call UI is handled by CallKit instead.

---

## 8. Regression fixes (must-have for "screen on but no call UI")

After the lock-screen work, incoming calls on a **closed/locked** app could light the
screen but never show the call UI. Two independent causes — fix BOTH:

### 8.1 Re-arm `showWhenLocked` on each incoming call
See **§4.1a**. `returnToLockScreen()` leaves `showWhenLocked=false` on the live
Activity; the next call can't draw over the keyguard until you reset it in the native
`display(...)`. This is the lock-screen-specific cause (only after a prior locked
call, when the app wasn't killed in between).

### 8.2 The logout "session guard" must check `accessToken` ONLY

If you added a logout guard that drops background pushes when logged out (so a
logged-out device never rings), it lives at the top of the FCM handlers
(`src/firebase/fcmService.js`):

```js
m().setBackgroundMessageHandler(async (remoteMessage) => {
  if (!(await hasActiveSession())) return;   // ← drops calls + messages
  // ...
});
```

**The guard must check `accessToken` ALONE.** An earlier version also required
`deviceId`, but the backend login response doesn't always store a `deviceId`
(`sessionManager.saveAuthSession` only writes it `if (deviceId)`), so a logged-in
user with no stored `deviceId` had **every** background call/message silently
dropped — screen wakes from the high-priority push, but no call UI.

```js
const hasActiveSession = async () => {
  try {
    // accessToken is the single source of truth for "logged in"; logout's
    // AsyncStorage.clear() removes it. Do NOT also require deviceId.
    const accessToken = await AsyncStorage.getItem('accessToken');
    return !!accessToken;
  } catch (_) {
    return true; // fail OPEN — better to show a call than to miss one
  }
};
```

> **Rule of thumb:** anything gating the incoming-call display path must **fail
> open**. A missed real call is worse than a stray notification. Only the explicit,
> token-cleared logout state should block.

### 8.3 Quick regression test
- [ ] Lock device → make a call → answer → end (runs `returnToLockScreen`) → make a
      SECOND call **without killing the app** → call UI must appear over the keyguard.
- [ ] Logged-in user with NO stored `deviceId` (check AsyncStorage) → closed-app call
      still rings.
- [ ] Log out → closed-app call does NOT ring.
