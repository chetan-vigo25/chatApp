import { requireOptionalNativeModule } from 'expo-modules-core';

// Optional: returns null on builds that don't include the native module (e.g.
// before the app is rebuilt, or iOS where this module is Android-only), so every
// caller degrades gracefully instead of crashing at import.
const Native = requireOptionalNativeModule('ExpoCallUi');

export type IncomingCallData = {
  callId: string;
  callerId?: string;
  callerName?: string;
  callerImage?: string | null;
  callType?: 'audio' | 'video';
};

export type CallAction = {
  // 'hangup' = End tapped on the active-call ongoing notification.
  // 'ongoing' = body tap on the active-call notification (re-open / restore).
  action: 'accept' | 'decline' | 'incoming' | 'hangup' | 'ongoing';
  callId: string;
  callerId?: string;
  callerName?: string;
  callerImage?: string | null;
  callType?: 'audio' | 'video';
};

export type OngoingCallData = {
  callId: string;
  callerName?: string;
  callerImage?: string | null;
  callType?: 'audio' | 'video';
  // Wall-clock ms when the call was answered; drives the duration chronometer.
  startedAt?: number;
  // 'ringing' = outgoing call dialed but not yet answered ("Calling…", no timer);
  // 'ongoing' = connected (duration chronometer). Defaults to 'ongoing'.
  state?: 'ringing' | 'ongoing';
};

export const isAvailable = (): boolean => !!Native;

export const displayIncomingCall = (data: IncomingCallData): void => {
  Native?.displayIncomingCall(data);
};

export const cancelIncomingCall = (callId: string): void => {
  Native?.cancelIncomingCall(callId);
};

// Start/stop the persistent active-call foreground service (Android only;
// no-op when the native module is absent).
export const startOngoingCall = (data: OngoingCallData): void => {
  Native?.startOngoingCall(data);
};

export const stopOngoingCall = (): void => {
  Native?.stopOngoingCall();
};

// On cold start, returns the action the launching notification carried (Answer
// tap / full-screen / body tap), or null. Consumed once.
export const getInitialCallAction = (): CallAction | null =>
  (Native?.getInitialCallAction() as CallAction) ?? null;

export const addCallActionListener = (cb: (e: CallAction) => void) =>
  Native?.addListener('onCallAction', cb);

// Dismiss every posted incoming-call notification (answer/end) — robust to the
// live call id having drifted from the posted id.
export const cancelAllIncomingCalls = (): void => {
  Native?.cancelAllIncomingCalls?.();
};

// Send the app behind the keyguard so the system lock screen reasserts (used
// when a locked-device call ends / is minimized).
export const returnToLockScreen = (): void => {
  Native?.returnToLockScreen?.();
};

// Tell the native keyguard backstop a call is ringing/connecting/active (true)
// or fully idle (false).
export const setCallActive = (active: boolean): void => {
  Native?.setCallActive?.(active);
};

// Non-consuming peek: was the app cold-started by a call full-screen intent?
// Returns the launch payload (or null) WITHOUT clearing it, so the cold-start
// cover can paint the call screen from the first frame.
export const peekInitialCallLaunch = (): CallAction | null =>
  (Native?.peekInitialCallLaunch?.() as CallAction) ?? null;

// Remove the native call-launch cover (no-op — the cover lives in RN).
export const hideCallLaunchCover = (): void => {
  Native?.hideCallLaunchCover?.();
};

// ---- background-delivery reliability (OEM battery / autostart) ----
// A killed/rebooted app on OEM skins (MIUI, FuntouchOS, ColorOS, …) is blocked
// from waking on the incoming-call FCM push unless the user exempts it from
// battery optimization AND enables OEM "Autostart". These let JS surface a
// one-time onboarding that jumps straight to those toggles. All degrade to a safe
// default on iOS / builds without the native module.

// True when already exempt from battery optimization (or the concept doesn't
// apply). Defaults to true when unknown so we never nag needlessly.
export const isIgnoringBatteryOptimizations = (): boolean =>
  Native?.isIgnoringBatteryOptimizations?.() ?? true;

// Open the system "allow background / ignore battery optimization" dialog for
// this app. Returns true if a screen was launched.
export const requestDisableBatteryOptimization = (): boolean =>
  Native?.requestDisableBatteryOptimization?.() ?? false;

// Open the OEM Autostart manager (or app-details settings as a fallback). Returns
// true when a manufacturer-specific autostart screen opened.
export const openAutoStartSettings = (): boolean =>
  Native?.openAutoStartSettings?.() ?? false;

// Device manufacturer string (raw; lower-case at the call site if needed).
export const getManufacturer = (): string =>
  (Native?.getManufacturer?.() as string) ?? '';

export default Native;
