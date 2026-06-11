# OTP Resend Banner — Show New Code on Resend

This documents the fix so that when the user taps **"Resend SMS?"**, the in-app OTP banner ("Your verification code is …") slides in again with the **new** code — exactly like it does on first send.

> **Use this when:** you replace/update the `src` folder and need to re-apply the resend banner behavior.
> Hinglish: Resend OTP karne pe wahi banner naye OTP ke saath dobara aana chahiye. `src` update ke baad neeche ke 3 file changes dobara lagao.

**Files:** `src/screens/Otp.jsx`, `src/Redux/Reducer/Auth/Auth.reducer.js`, `src/Redux/Services/Auth/Auth.Services.js`

> ✅ JS-only. No library, no native rebuild — just fast refresh.

---

## 🧠 What was broken

- The banner showed **only on first mount** (from the `initialOtp` route param via a `useEffect`).
- The **resend** handler showed a toast but never re-displayed the banner.
- Worse: the resend chain **threw away the new code** — the service returned only `otpMessage` and dropped `response.data` (the new OTP).

The fix threads the new OTP through the whole chain and reuses one banner function.

---

## 🔧 Re-apply in 3 edits

### Edit 1 — Service: return the new OTP data

**File:** `src/Redux/Services/Auth/Auth.Services.js` → `resendOtpService()`

```js
if (response.statusCode === 200) {
  console.log("new OTP", response.data);
  // return response;
  return { otpMessage: response.message, otpData: response.data };  // ← add otpData
}
```

> Earlier this returned only `{ otpMessage: response.message }`, dropping `response.data`.

---

### Edit 2 — Reducer: pass the full object through

**File:** `src/Redux/Reducer/Auth/Auth.reducer.js`

**Thunk** (`resendOtp`):

```js
const response = await authServices.resendOtpService(fullPhoneNumber);
return response; // { otpMessage, otpData } — otpData carries the new OTP
```

> Was: `return response.otpMessage;` (string only).

**Fulfilled case** — keep `state.otpMessage` a string so nothing else breaks:

```js
.addCase(resendOtp.fulfilled, (state, action) => {
  state.isLoading = false;
  state.otpMessage = action.payload?.otpMessage ?? action.payload;
  state.error = null;
})
```

---

### Edit 3 — Screen: reusable banner + show it on resend

**File:** `src/screens/Otp.jsx`

**3a.** Add `useCallback` to the React import:

```js
import React, { useState, useEffect, useRef, useCallback } from "react";
```

**3b.** Extract the banner animation into a reusable `showOtpBanner()`, and make the mount effect call it. **Replace** the old `useEffect(() => { if (initialOtp) { ...inline animation... } }, [initialOtp])` with:

```js
// Slide the in-app OTP banner in with a fresh code. Reused on first mount
// (initialOtp) and after a successful resend so the new code is shown again.
const showOtpBanner = useCallback((code, delay = 300) => {
  if (!code) return;
  setBannerOtp(String(code));
  setOtpBannerVisible(true);
  bannerSlideAnim.setValue(-200);
  bannerOpacity.setValue(0);
  // Small delay so the screen (or toast) renders first
  setTimeout(() => {
    Animated.parallel([
      Animated.spring(bannerSlideAnim, {
        toValue: 0,
        useNativeDriver: true,
        tension: 60,
        friction: 9,
      }),
      Animated.timing(bannerOpacity, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start();
  }, delay);
}, [bannerSlideAnim, bannerOpacity]);

// Show OTP banner when screen opens with a generated OTP
useEffect(() => {
  showOtpBanner(initialOtp);
}, [initialOtp, showOtpBanner]);
```

**3c.** In `handleResendOtp`, extract the new OTP from the payload and show the banner. Update the `.then(...)`:

```js
dispatch(resendOtp({ fullPhoneNumber }))
  .unwrap()
  .then((payload) => {
    const otpMessage = payload?.otpMessage ?? payload;
    const data = payload?.otpData;
    const newOtp = data?.otp || data?.code || data;   // same shape Login uses
    startOtpTimer(60);
    console.log("OTP Resend:", otpMessage);
    showToast(otpMessage);
    otpInputRef.current?.clear();
    setOtp("");
    // Re-show the in-app banner with the newly generated code
    showOtpBanner(newOtp);
  })
  .catch((error) => {
    console.error("OTP Resend Failed:", error);
    showToast(error);
  });
```

> The `data?.otp || data?.code || data` fallback matches how the first send extracts the OTP in `Login.jsx` (`const otp = data?.otp || data?.code || data;`).

---

## ✅ Verify

1. Go to the OTP screen → banner slides in with the code (first send).
2. Wait for the timer, tap **"Resend SMS?"** → toast appears **and** the banner slides back in with the **new** code.

> If the banner shows an empty/odd code on resend, the resend API's `response.data` shape differs from the first send. Check the `console.log("new OTP", response.data)` line and adjust the `data?.otp || data?.code || data` path in Edit 3c.

---

## 📂 Files touched (checklist)

- [ ] `src/Redux/Services/Auth/Auth.Services.js` — `resendOtpService` returns `otpData`.
- [ ] `src/Redux/Reducer/Auth/Auth.reducer.js` — thunk returns full object; fulfilled keeps `otpMessage` a string.
- [ ] `src/screens/Otp.jsx` — `useCallback` import, reusable `showOtpBanner`, resend handler shows banner with new OTP.
- [ ] No install, no rebuild — just fast refresh.
