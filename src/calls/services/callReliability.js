/**
 * callReliability — decides whether to offer the one-time "let calls ring when
 * the app is closed" onboarding, and remembers the user's choice.
 *
 * The problem it addresses: on OEM Android skins (MIUI, FuntouchOS, ColorOS, …) a
 * killed/rebooted app is blocked from starting in the background, so the
 * high-priority incoming-call FCM push is dropped and the phone never rings until
 * the app is opened once ("device restart ke baad call/notification nahi aata").
 * The two user-grantable escapes are (1) exempt from battery optimization and
 * (2) enable OEM Autostart. This module gates a prompt that jumps to those toggles.
 *
 * Non-intrusive rules:
 *   - Android only, and only while battery-optimization is NOT already granted.
 *   - Never after the user picked "Don't show again" (permaOff).
 *   - Snoozed for SNOOZE_DAYS after any dismissal, so it can't nag.
 *   - Stops offering forever the moment the exemption is actually granted.
 */
import { Platform, DeviceEventEmitter } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isIgnoringBatteryOptimizations, requestDisableBatteryOptimization } from '../../../modules/expo-call-ui';

// Fired by the Settings entry to force-open the reliability sheet on demand,
// bypassing the snooze / "don't show again" gating (the auto-prompt respects
// those; a manual tap should always work). CallReliabilityGate listens for it.
export const RELIABILITY_OPEN_EVENT = 'call:reliability:open';
export const openCallReliability = () => {
  DeviceEventEmitter.emit(RELIABILITY_OPEN_EVENT);
};

const PERMA_OFF_KEY = '@call/reliability/permaOff';
const SNOOZE_UNTIL_KEY = '@call/reliability/snoozeUntil';
const AUTO_ASKED_KEY = '@call/reliability/autoAsked';

// How long a dismissal quiets the prompt before it may reappear (only if the
// exemption is still missing).
const SNOOZE_DAYS = 14;
const SNOOZE_MS = SNOOZE_DAYS * 24 * 60 * 60 * 1000;

// True when the app is exempt from battery optimization (or the concept doesn't
// apply — iOS, pre-M, no native module). Cheap synchronous native read.
export const isBackgroundAllowed = () => {
  if (Platform.OS !== 'android') return true;
  try { return !!isIgnoringBatteryOptimizations(); } catch (_) { return true; }
};

// Should we surface the onboarding right now?
export const shouldOfferReliability = async () => {
  if (Platform.OS !== 'android') return false;
  if (isBackgroundAllowed()) return false; // already reliable — nothing to fix
  try {
    const [perma, snoozeUntil] = await Promise.all([
      AsyncStorage.getItem(PERMA_OFF_KEY),
      AsyncStorage.getItem(SNOOZE_UNTIL_KEY),
    ]);
    if (perma === 'true') return false;
    const until = parseInt(snoozeUntil || '0', 10);
    if (Number.isFinite(until) && Date.now() < until) return false;
    return true;
  } catch (_) {
    return false; // storage hiccup → don't nag
  }
};

// First-entry auto-request: fire the SYSTEM battery-optimization dialog
// directly (the small OS "Allow app to run in background?" prompt) instead of
// showing our own onboarding card — ONCE per install. Grant → calls ring
// forever, user never sees our card. Deny → we snooze the card too, so the
// user isn't nagged again right away (Settings can always reopen it).
// Returns true when the system dialog was fired (caller must NOT also show
// the custom card in that case).
export const maybeAutoRequestBackground = async () => {
  if (Platform.OS !== 'android') return false;
  if (isBackgroundAllowed()) return false;
  try {
    const asked = await AsyncStorage.getItem(AUTO_ASKED_KEY);
    if (asked === 'true') return false;
    await AsyncStorage.setItem(AUTO_ASKED_KEY, 'true');
    // Quiet the custom card for the snooze window — the system dialog IS the ask.
    await snoozeReliability();
    requestDisableBatteryOptimization();
    return true;
  } catch (_) {
    return false;
  }
};

// "Remind me later" — quiet the prompt for SNOOZE_DAYS.
export const snoozeReliability = async () => {
  try { await AsyncStorage.setItem(SNOOZE_UNTIL_KEY, String(Date.now() + SNOOZE_MS)); } catch (_) {}
};

// "Don't show again" — never auto-offer it again (Settings can still open it).
export const dismissReliabilityForever = async () => {
  try { await AsyncStorage.setItem(PERMA_OFF_KEY, 'true'); } catch (_) {}
};

// Once the exemption is granted, clear any snooze/permaOff so the state is clean
// (and a future revoke can re-offer). Best-effort.
export const clearReliabilityFlags = async () => {
  try {
    // AUTO_ASKED_KEY too — if the exemption is later revoked, the first-entry
    // system dialog may fire once again instead of the custom card.
    await AsyncStorage.multiRemove([PERMA_OFF_KEY, SNOOZE_UNTIL_KEY, AUTO_ASKED_KEY]);
  } catch (_) {}
};
