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
  action: 'accept' | 'decline' | 'incoming';
  callId: string;
  callerId?: string;
  callerName?: string;
  callerImage?: string | null;
  callType?: 'audio' | 'video';
};

export const isAvailable = (): boolean => !!Native;

export const displayIncomingCall = (data: IncomingCallData): void => {
  Native?.displayIncomingCall(data);
};

export const cancelIncomingCall = (callId: string): void => {
  Native?.cancelIncomingCall(callId);
};

// On cold start, returns the action the launching notification carried (Answer
// tap / full-screen / body tap), or null. Consumed once.
export const getInitialCallAction = (): CallAction | null =>
  (Native?.getInitialCallAction() as CallAction) ?? null;

export const addCallActionListener = (cb: (e: CallAction) => void) =>
  Native?.addListener('onCallAction', cb);

export default Native;
