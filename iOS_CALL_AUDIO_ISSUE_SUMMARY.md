# iOS Call Audio — Issue, Root Cause & Action Plan

**Prepared for:** Management review
**Date:** 2026-07-06
**Area:** iOS voice/video calling

---

## 1. Current status

| Feature | Status |
|---|---|
| Incoming call notification / banner (Android + iOS) | ✅ Working |
| iOS **native full-screen call screen** on lock screen / when app is closed (WhatsApp-style) | ✅ Working |
| **Call audio on iOS after answering** (voice + video, both directions) | ❌ **Not working** |

The visible calling experience on iOS is now correct. The **only** remaining
problem is that **once an iOS call is answered, neither side can hear audio.**

---

## 2. Why the audio fails (root cause)

- Our app's voice/video **media engine runs inside an embedded web browser
  (WebView)**, using a **third-party browser calling SDK** served from
  `call.vigorousit.com`.
- iOS gives each phone call **one shared audio channel** (the system
  `AVAudioSession`).
- To show a **native call screen on the lock screen**, iOS **requires Apple's
  "CallKit"** framework. There is no other Apple-approved way to ring a
  locked/closed iPhone full-screen.
- **The conflict:** when CallKit answers a call, iOS hands that single audio
  channel to CallKit. But our audio lives inside the **WebView**, whose audio is
  controlled internally by the browser engine — and the browser engine **cannot
  hand its audio over to CallKit**. Result: the call connects, but **no sound
  flows** in either direction.

**This is a known iOS platform limitation of "WebView-based calling + CallKit,"
not a coding mistake.** With the current WebView engine, the native lock-screen
call screen and working audio **cannot both work at the same time.**

> WhatsApp / Telegram do not hit this because they use **native WebRTC**, which
> *can* share the audio channel with CallKit.

---

## 3. The solution

**Migrate the call media engine from the WebView + third-party browser SDK to
native WebRTC (`react-native-webrtc`).**

Native WebRTC owns the audio channel at the OS level and **can share it with
CallKit** — so the **native lock-screen ring AND the call audio both work**,
exactly like WhatsApp.

There is no smaller/quicker code fix — this platform limitation is the reason the
migration is required.

---

## 4. What needs to be done

### 🖥️ Server-side (calling infrastructure / `vigorousit` team)

1. **Provide the calling SDK's signaling protocol specification** — i.e. the
   socket.io events, message payloads, and the connection/negotiation handshake
   the current browser SDK uses to talk to `call.vigorousit.com` — **OR** provide
   a **React-Native-compatible SDK / the SDK source code.**
   👉 **This is the main dependency. The migration cannot begin without it.**
2. **Confirm the group-call architecture** — does a group call use a media server
   (SFU) or direct peer-to-peer? (Affects the effort estimate.)
3. **Keep sending the iOS VoIP push** for incoming calls (already integrated and
   working — powers the native call screen).

### 📱 App-side (mobile team)

1. Add the native WebRTC library and produce a new app build.
2. Re-implement the call engine natively against the SDK's signaling protocol.
   *(The app's calling UI and logic are cleanly separated from the media engine,
   so this stays isolated — the rest of the app is largely unaffected.)*
3. Connect native WebRTC audio to CallKit so audio starts correctly on answer.
4. Test on physical iPhone (locked / closed app) and Android.

---

## 5. Effort & dependency

- **Estimated effort:** multi-week project (dominated by re-implementing the call
  engine and testing on real devices).
- **Blocked on:** the calling SDK signaling protocol from the server / `vigorousit`
  team (Server-side item #1). Once that is available, the app-side work can
  proceed end-to-end.

---

## 6. Interim position (today)

- The **native iOS call screen is turned ON** for a complete visual experience.
- **Trade-off:** audio will not work on iOS until the migration is complete.
- If **working audio is needed sooner** than the native screen, we can temporarily
  switch back to the in-app call screen (audio works, but no native lock-screen
  full-screen ring). This is a 1-line, no-risk toggle.

---

### One-line summary for leadership
> iOS calling now shows the native WhatsApp-style ring, but audio is silent on
> answer because our call media runs in a WebView, which iOS's CallKit cannot
> share audio with. The fix is to move call media to native WebRTC. The only thing
> blocking the start is getting the calling SDK's signaling protocol (or an
> RN-compatible SDK) from the calling-server team.
