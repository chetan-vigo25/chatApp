# iOS VoIP Push (PushKit) — Backend Spec

**Why:** On iOS, when the app is **killed + the phone is locked**, there is no
socket connection, so `call:incoming` cannot reach the device. The **only** way to
ring an iPhone full-screen (native CallKit screen, like WhatsApp) in that state is
an **APNs VoIP push (PushKit)**. A normal APNs alert / FCM data push **cannot** do
this — it only shows a banner and never launches CallKit.

The **app side is fully implemented** (PushKit handler in AppDelegate reports the
call to CallKit; the app registers a VoIP token and sends it to the backend). The
**only missing piece is the backend sending the VoIP push.** This doc is that
contract.

---

## 1. Store the per-device VoIP token

The app sends the token over the existing socket event on every connect / token
refresh:

```
socket event: "notification:device:register"
payload: {
  deviceId,
  pushProvider: "apns",       // iOS
  voipToken: "<64-hex APNs PushKit token>",   // <-- STORE THIS per device
  pushToken:  "<regular APNs/FCM token>",     // for message/alert pushes (separate)
  deviceInfo: { platform, version, model }
}
```

- Persist `voipToken` on the device/session row **separately** from the normal
  `pushToken`. The VoIP token is different from the APNs alert token.
- On logout / `notification:device:unregister`, clear it.

## 2. When to send the VoIP push

Send it to the **callee's** iOS devices at the moment a call is placed. Two
triggers already exist in the app; both must fan out the VoIP push for iOS devices:

1. **`POST /api/v2/user/call/notify`** — body `{ peerId, media, callId }`. The
   caller hits this so a backgrounded/killed callee still rings.
2. Your server-side `call:ring` handler (`pushOfflineCallees`) — same idea for
   offline callees.

For each callee device where `pushProvider === "apns"` **and** a `voipToken`
exists → send the APNs VoIP request below. (Android devices keep using the FCM
data push exactly as today.)

## 3. The APNs VoIP request

| Field | Value |
|---|---|
| **URL (path)** | `POST /3/device/{voipToken}` |
| **Host — sandbox** | `api.sandbox.push.apple.com:443` — for **dev / EAS `development`** builds |
| **Host — production** | `api.push.apple.com:443` — for **TestFlight / App Store** builds |
| **`apns-topic`** | `com.chat.baatCheet.voip`  ← bundle id **+ `.voip`** (required for VoIP) |
| **`apns-push-type`** | `voip` |
| **`apns-priority`** | `10` |
| **`apns-expiration`** | `0` (or now+30s — a call is only useful briefly) |
| **Auth** | VoIP Services **certificate** (p12), **or** a `.p8` token key (JWT `Authorization: bearer <jwt>`) |

> ⚠️ **Environment must match the build.** The current app is built with
> `aps-environment = development` (see `plugins/withIosVoip.js`), so its VoIP token
> is a **sandbox** token → you MUST use `api.sandbox.push.apple.com`. Sending a
> sandbox token to the production host (or vice-versa) fails **silently** — Apple
> returns `400 BadDeviceToken` and nothing rings. When you ship to TestFlight/App
> Store the plugin's `APS_ENVIRONMENT` becomes `production` → switch to the
> production host for those builds.

### Payload (JSON body)

```jsonc
{
  "uuid": "E621E1F8-C36C-495A-93FC-0C247A3E6E5F",  // REQUIRED — see below
  "callId": "sig_<callerId>_<ms>",                  // the app signaling id
  "callerId": "699bf91c9906da6a8930514c",
  "callerName": "User11",
  "callerImage": "https://.../avatar.webp",
  "callType": "audio"                               // "audio" | "video"
}
```

> ⚠️ **`uuid` MUST be a valid RFC 4122 UUID.** CallKit rejects anything else and
> the app is killed by iOS for reporting an invalid call. **Do NOT** reuse the
> `sig_..._<ms>` signaling id as the uuid — it is not a UUID. Generate a fresh
> UUID **per call**, send it as `uuid`, and (recommended) remember the
> `uuid → callId` mapping server-side so a later "call cancelled / ended" event can
> be correlated. The app binds this `uuid` to the call so its own hang-up dismisses
> the CallKit screen.

There is **no `aps` dictionary** in a VoIP push — the whole payload is custom keys.

## 4. Node examples

### Option A — `node-apn` (`@parse/node-apn`)

```js
const apn = require('@parse/node-apn');
const { randomUUID } = require('crypto');

const provider = new apn.Provider({
  token: { key: './AuthKey_XXXX.p8', keyId: 'XXXXXXXXXX', teamId: 'YYYYYYYYYY' },
  production: false, // false = sandbox (dev/EAS development build). true for App Store.
});

async function sendCallVoip(voipToken, call) {
  const note = new apn.Notification();
  note.topic = 'com.chat.baatCheet.voip';   // bundle id + .voip
  note.pushType = 'voip';
  note.priority = 10;
  note.expiry = 0;
  note.payload = {
    uuid: randomUUID(),           // valid RFC4122 UUID, per call
    callId: call.callId,
    callerId: call.callerId,
    callerName: call.callerName,
    callerImage: call.callerImage || null,
    callType: call.media === 'video' ? 'video' : 'audio',
  };
  const res = await provider.send(note, voipToken);
  // res.failed[].response.reason: BadDeviceToken / DeviceTokenNotForTopic / ...
  return res;
}
```

### Option B — raw HTTP/2 + `.p8` JWT (`http2` + `jsonwebtoken`)

```js
const http2 = require('http2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const { randomUUID } = require('crypto');

const KEY = fs.readFileSync('./AuthKey_XXXX.p8');
const authToken = jwt.sign({ iss: 'TEAMID', iat: Math.floor(Date.now()/1000) }, KEY, {
  algorithm: 'ES256', header: { alg: 'ES256', kid: 'KEYID' },
}); // cache & refresh < 60 min

function sendCallVoip(voipToken, payload, { sandbox = true } = {}) {
  const host = sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  const client = http2.connect(host);
  const req = client.request({
    ':method': 'POST',
    ':path': `/3/device/${voipToken}`,
    'authorization': `bearer ${authToken}`,
    'apns-topic': 'com.chat.baatCheet.voip',
    'apns-push-type': 'voip',
    'apns-priority': '10',
    'apns-expiration': '0',
    'content-type': 'application/json',
  });
  req.setEncoding('utf8');
  let status; let body = '';
  req.on('response', (h) => { status = h[':status']; });
  req.on('data', (d) => { body += d; });
  req.on('end', () => { client.close(); if (status !== 200) console.warn('VoIP push failed', status, body); });
  req.end(JSON.stringify({ uuid: randomUUID(), ...payload }));
}
```

## 5. How to verify (in order)

1. **Token reaching backend?** Log the `voipToken` on `notification:device:register`
   for an iOS device. If it's empty/absent, the app build lacks the VoIP module or
   PushKit didn't register — rebuild (dev/EAS, physical device).
2. **APNs response.** Send a test VoIP push and read the APNs status:
   - `200` → delivered. If nothing rings, the app build/registration is the issue.
   - `400 BadDeviceToken` / `DeviceTokenNotForTopic` → **wrong environment**
     (sandbox↔prod mismatch) or wrong `apns-topic`.
   - `403 InvalidProviderToken` → wrong `.p8` key id / team id, or clock skew.
   - `410 Unregistered` → token stale; wait for the next `device:register`.
3. **Physical device only.** PushKit/CallKit never work in the Simulator or Expo Go.

## 6. Do NOT

- ❌ Send a normal alert push / FCM data push expecting CallKit — only `apns-push-type: voip` on the `.voip` topic works.
- ❌ Reuse the `sig_..._<ms>` id as `uuid` (invalid UUID → app killed by iOS).
- ❌ Send a sandbox token to the production host or vice-versa (silent failure).
- ❌ Send a VoIP push without reporting a call to CallKit — the app's AppDelegate
  already does that synchronously; just deliver the push.

---

**App-side references (already implemented, no change needed):**
- `plugins/withIosVoip.js` — AppDelegate PushKit → `RNCallKeep.reportNewIncomingCall`
- `src/calls/services/voipPushService.js` — VoIP token registration + push → ring
- `src/calls/services/nativeCallService.js` — CallKit bridge (incoming-only)
- `src/Redux/Services/Socket/socket.js` — `notification:device:register` carries `voipToken`
