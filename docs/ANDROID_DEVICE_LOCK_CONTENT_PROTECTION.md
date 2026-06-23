# Android Device-Lock Content Protection — Security Audit & Fix

App content (chats, profile, settings) was visible and interactive **over the lock
screen** after the device was locked and woken, with no unlock required.

---

## 1. Root cause analysis

### Issue
The app draws over the system keyguard. Lock the phone → wake it (still locked) →
the last app screen is shown and partly interactive.

### Location
- **`plugins/withCallFullScreen.js`** — lines ~43–44:
  ```js
  mainActivity.$['android:showWhenLocked'] = 'true';
  mainActivity.$['android:turnScreenOn']  = 'true';
  ```
- Applied to **`MainActivity`**, which hosts the ENTIRE single-Activity React Native
  app — so the flag exposes every screen, not just calls.

### Severity
**Critical** — sensitive content (private chats) is readable on a locked device by
anyone with physical access.

### Root cause
`android:showWhenLocked="true"` tells Android the activity may render on top of the
keyguard. It was added so an **incoming call** could appear over the lock screen,
but as a **static** manifest flag it applies **at all times** to the whole app, not
just during calls. Android, not React Native/Expo/navigation, is doing the
exposing — so no JS-level navigation/auth guard can prevent it.

### Attack scenario
1. Victim opens a chat, locks the phone (screen off).
2. Attacker (physical access) presses power — screen wakes, still locked.
3. The victim's chat is on screen; the attacker reads messages and can sometimes
   scroll/navigate before any unlock.

### Why "sometimes"
`AppLockGate` (the optional in-app PIN/biometric lock) re-locks only after a
**background cooldown** and only if a PIN is set — so within the cooldown, or with
no PIN configured, content is exposed.

### iOS
**Not affected.** iOS never renders an app over its lock screen; the OS hides it
automatically. This is an Android-only issue (the `showWhenLocked` flag).

---

## 2. The fix — make `showWhenLocked` DYNAMIC

Keep the manifest flag (a **cold-start** incoming call still needs to appear over
the keyguard — and a killed app has no content to expose, it boots straight into
the call), but **revoke it at runtime whenever the app is backgrounded/locked
without an active call**. Then the system keyguard hides the app exactly like
WhatsApp; the device PIN/biometric is the gate.

### 2.1 Native setter (already present from the call work)
`modules/expo-call-ui` exposes `setShowWhenLocked(show)` →
`activity.setShowWhenLocked(show)` (API 27+), which **overrides** the manifest value
at runtime.

### 2.2 JS wrapper — `src/firebase/callNotifee.js`
```js
export const setShowWhenLockedNative = (show) => {
  if (!isCallUi()) return;                       // Android + native module only
  try { getCallUi().setShowWhenLocked(!!show); } catch (_) { /* best-effort */ }
};
```

### 2.3 Protection guard — `src/calls/CallProvider.jsx`
`CallProvider` wraps the whole app, so one AppState listener protects every screen:
```jsx
useEffect(() => {
  const onAppStateChange = (next) => {
    if (next === 'active') return;               // unlocked & in use → nothing to do
    // Keep drawing over the keyguard ONLY while a call is in progress.
    if (stateRef.current.status === CALL_STATUS.IDLE) {
      setShowWhenLockedNative(false);            // → keyguard hides the app
    }
  };
  const sub = AppState.addEventListener('change', onAppStateChange);
  return () => sub.remove();
}, []);
```

### 2.4 Clear after an unlocked call — `finalizeEnd` reset
The incoming-call `display()` arms `showWhenLocked(true)`; clear it when a call ends
unlocked so a later lock is protected:
```js
if (lockedCallRef.current || isDeviceLockedNow()) {
  returnToLockScreen();                          // locked: behind keyguard + lock
  // ...
} else {
  setShowWhenLockedNative(false);                // unlocked: just clear the flag
}
```

---

## 3. Behaviour after the fix

| Scenario | Before | After |
|---|---|---|
| Use app → lock → wake (still locked) | App content visible ❌ | Keyguard hides app ✅ |
| Incoming call, app alive, locked | shows over lock | shows over lock ✅ (display arms it) |
| Incoming call, app killed, locked | shows over lock | shows over lock ✅ (manifest; no content to expose) |
| Call ends → device locked | back to lock screen | back to lock screen ✅ |
| Call ends → device unlocked | (flag left on) | flag cleared → next lock protected ✅ |
| iOS, any | already safe | already safe ✅ |

---

## 4. Residual notes & optional hardening

- **Lock-then-instant-wake race:** the flag is revoked on the background transition,
  so there's a sub-second window on the very first lock after launch. For most
  threat models this is acceptable. A fully race-proof version sets
  `setShowWhenLocked(false)` natively in `MainActivity.onPause()` (needs a config
  plugin that edits `MainActivity`) — out of scope here.
- **App-switcher / recents preview (separate concern):** to also hide content in the
  recents thumbnail and block screenshots, call
  `expo-screen-capture`'s `preventScreenCaptureAsync()` (the dependency is already
  installed) on sensitive screens, or apply `FLAG_SECURE`. Trade-off: it blocks ALL
  screenshots app-wide.
- **iOS app-switcher snapshot:** iOS captures a snapshot for the switcher. To mask
  it, render a blur/cover view on `AppState === 'inactive'`. Optional.
- **`AppLockGate`** (in-app PIN/biometric) is complementary — keep it for users who
  want an app-level lock on top of the device keyguard.

---

## 5. Test checklist (real device, secure PIN/biometric lock)

- [ ] Open a chat → lock → wake (don't unlock) → **keyguard only**, no chat visible.
- [ ] Same for Profile, Settings, Calls list.
- [ ] Unlock → app resumes on the previous screen normally.
- [ ] Incoming call while locked (app in background) → call UI appears over lock.
- [ ] Incoming call while locked (app killed) → call UI appears over lock.
- [ ] Answer from lock → end → lands on the lock screen (not the app).
- [ ] Normal unlocked call → end → use app → lock → keyguard hides app (flag cleared).
- [ ] iOS: lock during any screen → app not shown over lock (unchanged).

---

## 6. Files changed
- `src/firebase/callNotifee.js` — `setShowWhenLockedNative()` wrapper.
- `src/calls/CallProvider.jsx` — AppState protection guard + clear-on-unlocked-end.
- (native `setShowWhenLocked` already shipped with the lock-screen call work.)

**JS-only change → Metro reload, no native rebuild required.**
