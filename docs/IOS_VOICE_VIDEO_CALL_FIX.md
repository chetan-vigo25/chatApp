# iOS Voice / Video Call Fix

> Commit: `31e7b31 iOScalling` (2026-06-17)
> Use this doc to re-apply / attach the call fix when updating the `src` folder with new code.

## TL;DR

On iOS, voice & video calls were failing to start. The root cause was **not** the call
engine — it was the network layer. The very first thing a call does is fetch a call token
over HTTPS/HTTP (`GET user/call/token`). That request was being **rejected by iOS
NSURLSession before the call could even begin**, surfacing as `ERR_NETWORK`. Two distinct
iOS-only causes were fixed, plus diagnostics so the real failure is visible next time.

The same commit also hardened messaging/socket reliability (see [Related changes](#related-changes-same-commit)),
but the **call-critical** pieces are the four files below.

---

## Root causes

1. **App Transport Security (ATS) blocked the request.**
   When pointed at the LAN/dev backend over `http://` (cleartext) or a local-network host,
   iOS refuses the connection unless ATS exceptions and the Local Network usage description
   are declared in `Info.plist`. Without them: `ERR_NETWORK`, while `curl`/Safari work fine.

2. **GET requests were carrying a request body.**
   `axios` serializes the `data` argument even on a `GET`. iOS `NSURLSession` rejects such a
   response with **CFNetwork `-1103` "resource exceeds maximum size"**, which bubbles up as
   `ERR_NETWORK`. `curl`/Safari work because they send GETs with no body. The call-token GET
   was the first victim, so calls never got a token.

3. **No usable diagnostics.** The generic silent logger only printed an (undefined) HTTP
   status, so an ATS block, a connection refusal, a timeout, and a 401 all looked identical.

---

## The fixes (call-critical files)

### 1. `app.json` — declare ATS exceptions + Local Network usage

Under `ios.infoPlist`:

```json
"NSAppTransportSecurity": {
  "NSAllowsArbitraryLoads": true,
  "NSAllowsLocalNetworking": true
},
"NSLocalNetworkUsageDescription": "TalksTry connects to a development server on your local network to load chats, calls, and media during testing."
```

> ⚠️ These are native `Info.plist` keys. After changing them you **must rebuild the native
> iOS app** (`npx expo run:ios`) — a Metro reload is **not** enough. First launch will also
> prompt for **Allow Local Network**; the user must accept it.

### 2. `src/Config/Https.js` — never send a body on GET/HEAD

In `apiCall`, before issuing the request:

```js
// Bodyless methods (GET/HEAD) must NOT carry a request body. Sending one
// (axios serializes `data` even on GET) makes iOS NSURLSession reject the
// response with CFNetwork -1103 "resource exceeds maximum size" → surfaces
// as ERR_NETWORK. curl/Safari work because they send GETs with no body.
const m = String(method || 'get').toLowerCase();
const hasBody = m !== 'get' && m !== 'head';

const response = await api({
  method,
  url,
  ...(hasBody ? { data } : {}),
  ...restConfig,
  _retryOnNetwork: retryOnNetwork,
});
return response.data;
```

And richer silent-error logging so a network failure is distinguishable from an HTTP error:

```js
console.log('[API:silent]', {
  status: error?.response?.status,
  code: error?.code,
  message: error?.message,
  url: buildUrl(endpoint),
  baseURL: BACKEND_URL,
});
```

### 3. `src/calls/services/callTokenService.js` — surface the real token-fetch failure

Wrap the token GET so the actual axios diagnostics are logged (ATS block vs. refusal vs.
timeout vs. 401), instead of the generic `[API:silent]` undefined status:

```js
let res;
try {
  res = await apiCall('get', 'user/call/token', {}, { silent: true });
} catch (err) {
  // The token GET failed at the network layer (no HTTP response → status is
  // undefined). Surface the REAL axios diagnostics so we can tell apart an
  // ATS/cleartext block, a connection refusal, a timeout, and an auth (401)
  // failure — the generic [API:silent] log only prints the (undefined) status.
  if (__DEV__) {
    console.log('[CALL][APP][token] ✗ request FAILED', {
      code: err?.code,
      name: err?.name,
      message: err?.message,
      status: err?.response?.status,
      hasResponse: !!err?.response,
      hasRequest: !!err?.request,
    });
  }
  throw err;
}
```

### 4. `src/firebase/callNotifee.js` — always register the notifee background handler

notifee **requires** a top-level background event handler whenever the library is in the
build, or it logs *"no background event handler has been set"* the first time any notifee
notification raises a background event. Register it unconditionally; the call branch simply
no-ops when the native CallStyle (`ExpoCallUi`) backend owns Answer/Decline:

```js
export const registerNotifeeBackground = () => {
  // Register unconditionally when notifee is present, even when native CallStyle
  // handles call actions itself via a BroadcastReceiver.
  const notifee = getNotifee();
  if (!notifee) return;
  try {
    notifee.onBackgroundEvent(async ({ type, detail }) => {
      // CallStyle handles its own Answer/Decline natively; only route call
      // actions here when notifee is the active call backend.
      if (isCallUi()) return;
      const action = routeNotifeeEvent(type, detail);
      if (action === 'decline' || action === 'accept') {
        await cancelIncomingCallNotifee(detail?.notification?.data?.callId);
        // ...
      }
    });
  } catch (e) { /* ... */ }
};
```

---

## How to verify the fix

1. Rebuild the native iOS app: `npx expo run:ios` (NOT just a Metro reload).
2. On first launch, accept the **Allow Local Network** prompt.
3. Start a voice or video call. Watch Metro logs:
   - Success: `[CALL][APP][token] → GET user/call/token` followed by a token.
   - Still failing: `[CALL][APP][token] ✗ request FAILED` now shows the **real** cause
     (`code`/`message`) — use it to diagnose ATS vs. refusal vs. timeout vs. 401.

## Gotchas / environment notes

- ATS / Local Network changes need a **native rebuild**, not a JS reload.
- If `curl`/Safari reach the backend but the app gets `ERR_NETWORK` + CFNetwork `-1103`,
  it's the **GET-body** bug (fix #2), not ATS.
- If the Mac is on **Ethernet + Wi-Fi on the same subnet**, NSURLSession can fail with
  `-1103` regardless — turn off one interface and restart Metro on the remaining IP.
- Backend dev host used here: `192.168.1.37` (`BACKEND_URL=http://192.168.1.37:5000/api/v2/`,
  `SOCKET_URL=ws://192.168.1.37:5100`). The `.env` in this commit toggles between LAN dev and
  the `chatback.vigorousit.com` prod hosts — pick the right one for your build.

---

## Related changes (same commit)

These shipped in `31e7b31` too but are **not** call-token-critical — apply if you also want
the messaging/socket reliability improvements:

| File | What it does |
|------|--------------|
| `App.js` | Re-registers the **current FCM token** with the backend on every boot via `setPushToken(token)` — fixes call/message pushes reporting `sent: 0` after a rebuild/reinstall rotates the token. |
| `src/Redux/Services/Socket/socket.js` | Emits `presence:update` online/offline + `app:state` on foreground/background so the user stops showing "online" while backgrounded. |
| `src/contexts/RealtimeChatContext.js` | Emits `chat:thread:update` after persisting an incoming message; reconnect catch-up now sources chat IDs from **DB + memory** to close a cold-reopen race. |
| `src/contexts/useChatLogic.js` | Open chat screen re-reads from SQLite on `chat:thread:update`; preserves locally-created messages until their DB write lands; **queues** offline-sent messages for replay on reconnect instead of marking them `failed`. |
| `src/services/ChatDatabase.js` | `getAllChatIds()` for reconnect catch-up; `withExclusiveTransactionAsync` + transient-lock retry to stop `finalizeAsync` / "database is locked" warnings under concurrent writes. |
