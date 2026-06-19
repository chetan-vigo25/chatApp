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

export default Native;
