import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { ShareIntentModule, useShareIntentContext } from 'expo-share-intent';
import * as Linking from 'expo-linking';

import { navigationRef } from '../Redux/Services/navigationService';
import { getStoredSession } from '../services/sessionManager';
import { normalizeShare } from './ShareManager';

/**
 * ShareIntentGate — routes an incoming OS share into the app.
 *
 *   OS share sheet → (this) → auth check → ShareInbox (chat picker)
 *                              → ChatScreen → existing sendMedia pipeline
 *
 * Mounted once, inside NavigationContainer (so navigationRef is ready). Renders
 * nothing. It only fires when the app is opened FROM a share; normal launches are
 * untouched.
 *
 * Auth-gated: an unauthenticated user is sent to onboarding and the share is
 * dropped (a logged-out user has no chat to send to). Uses the same
 * getStoredSession() check Splash uses, so behaviour matches the rest of the app.
 */
// Screens that are still mid-boot: each one ENDS by calling navigation.reset(),
// which replaces the entire stack. Navigating to ShareInbox while one of these
// is on top means the reset wipes it — the picker appears for a frame and then
// drops the user on the chat list.
const BOOTING_ROUTES = new Set(['Splash', 'Permissions', 'SyncScreen']);

// Long enough to cover a cold start that walks Splash → Permissions → SyncScreen
// (the permission intro waits on the user), short enough that a share can't hang
// a timer forever. Dropping the share after this beats replaying a stale one.
const WAIT_INTERVAL_MS = 150;
const WAIT_TICKS = 400; // 60s

const isBootingRoute = () => {
  try {
    return BOOTING_ROUTES.has(navigationRef.getCurrentRoute()?.name);
  } catch {
    return true; // unreadable state → treat as still booting, never navigate blind
  }
};

export default function ShareIntentGate() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();

  // iOS ONLY — re-arm the native read on EVERY share.
  //
  // The share extension always opens the same url: `talkstry://dataUrl=talkstryShareKey#media`.
  // The key is a constant, so the string never differs between shares. Meanwhile
  // expo-share-intent only reads the App Group when expo-linking's
  // `useLinkingURL()` STATE changes — and React bails out of a setState with an
  // identical string, so that effect never re-ran. The first share of a session
  // worked (null → url) and every later one was dropped on the floor: the share
  // extension flashed open, wrote the file, opened the url, and the app ignored
  // it. (Verified on device: the native url event fires every time; the library
  // logs nothing, and a manual getShareIntent() immediately produced the share
  // that had been sitting unread in the App Group.)
  //
  // A share that arrives from ANOTHER app still recovered, because launching us
  // is a background→active transition and the library re-reads on that. Sharing
  // our own QR into TalksTry does not: the extension is presented inside our own
  // window, we never leave the foreground, and the url event is the only signal
  // there is. So read the App Group from that event ourselves. Android is
  // untouched — it re-reads the intent on its own.
  useEffect(() => {
    if (Platform.OS !== 'ios') return undefined;
    const pull = (url) => {
      // Only the share-extension handoff url; a normal deep link has no payload.
      if (!url || !url.includes('://dataUrl=')) return;
      console.log('[SHARE] ios re-read app group', { url });
      // Harmless when nothing is waiting: the native side answers "empty" and
      // emits no event, so this can't replay a share we already consumed.
      try { ShareIntentModule?.getShareIntent(url); } catch (_) {}
    };
    const urlSub = Linking.addEventListener('url', (event) => pull(event?.url));
    // Coming back from the share sheet is the other moment content can be
    // waiting — the extension writes the App Group BEFORE it opens the url, and
    // a url that never changed can't wake the library by itself.
    const appSub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      try { pull(Linking.getLinkingURL?.()); } catch (_) {}
    });
    return () => { urlSub?.remove?.(); appSub?.remove?.(); };
  }, []);

  const handlingRef = useRef(false);
  const unmountedRef = useRef(false);

  // expo-share-intent hands back a NEW `resetShareIntent` identity on every
  // render (useShareIntent.js defines it inline, with no useCallback) and the
  // provider's value is a fresh object literal. Held in refs instead of listed as
  // effect deps: as dependencies they re-ran this effect on every render, whose
  // cleanup cancelled the in-flight handler while `handlingRef` blocked a fresh
  // attempt — so on Android, where a cold start re-renders constantly, the share
  // was cancelled forever and ShareInbox never appeared. iOS only survived
  // because a warm app gave it a quiet window.
  const shareIntentRef = useRef(shareIntent);
  shareIntentRef.current = shareIntent;
  const resetShareIntentRef = useRef(resetShareIntent);
  resetShareIntentRef.current = resetShareIntent;

  // Cancel in-flight work on UNMOUNT ONLY — never on a re-render.
  useEffect(() => () => { unmountedRef.current = true; }, []);

  // A CONTENT-derived key, not the object identity. `hasShareIntent` alone is
  // not enough to re-trigger: it stays true across back-to-back shares, so a
  // second share never re-ran the effect and simply left the user on the chat
  // list. The raw `shareIntent` object can't be used either — its identity
  // changes every render (see above). This string is stable per share and
  // changes only when genuinely new content arrives.
  const shareKey = shareIntent
    ? [
        ...(Array.isArray(shareIntent.files) ? shareIntent.files : []).map(
          (f) => f?.path || f?.contentUri || f?.fileName || '',
        ),
        shareIntent.text || '',
        shareIntent.webUrl || '',
      ].join('|')
    : '';

  useEffect(() => {
    if (!hasShareIntent || !shareKey || handlingRef.current) return;
    handlingRef.current = true;

    const shareIntent = shareIntentRef.current;
    const resetShareIntent = (...args) => resetShareIntentRef.current?.(...args);

    (async () => {
      try {
        const payload = normalizeShare(shareIntent);

        console.log('[SHARE] intent received', {
          platform: Platform.OS,
          files: payload.files.length,
          text: payload.text ? `${payload.text.slice(0, 40)}…` : undefined,
          firstUri: payload.files[0]?.file?.uri,
          firstName: payload.files[0]?.file?.name,
          firstType: payload.files[0]?.type,
          rawFileCount: Array.isArray(shareIntent?.files) ? shareIntent.files.length : 0,
        });

        // Nothing usable came through — clear and bail.
        if (!payload.files.length && !payload.text) {
          console.warn('[SHARE] dropped: no usable files or text', shareIntent);
          resetShareIntent();
          return;
        }

        // Wait until navigation is ready AND the boot chain has settled.
        //
        // navigationRef.isReady() alone is not enough: it flips true the moment
        // the container mounts, while Splash is still resolving auth. Every
        // startup screen finishes with navigation.reset() — Splash, PermissionsGate,
        // SyncScreen — which REPLACES the whole stack. Pushing ShareInbox before
        // that lands made the picker flash on screen and vanish into the chat list
        // a moment later.
        //
        // Warm shares (app already open on a normal screen) settle on the first
        // check, so this costs nothing there.
        let waited = 0;
        for (let i = 0; i < WAIT_TICKS; i += 1) {
          if (navigationRef.isReady() && !isBootingRoute()) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, WAIT_INTERVAL_MS));
          waited += WAIT_INTERVAL_MS;
          if (unmountedRef.current) return;
        }
        if (unmountedRef.current || !navigationRef.isReady() || isBootingRoute()) {
          console.warn('[SHARE] dropped: navigation never settled', {
            waitedMs: waited,
            ready: navigationRef.isReady(),
            route: navigationRef.isReady() ? navigationRef.getCurrentRoute()?.name : null,
          });
          // Clear the library's state even on the give-up path. Leaving it set
          // pins hasShareIntent true, and a stale intent that can never be
          // handled would otherwise sit there poisoning the gate.
          if (!unmountedRef.current) resetShareIntent();
          return;
        }
        console.log('[SHARE] navigation settled', {
          waitedMs: waited,
          route: navigationRef.getCurrentRoute()?.name,
        });

        const session = await getStoredSession();
        const authed = !!(session?.userInfo && session?.accessToken);
        if (unmountedRef.current) return;

        if (!authed) {
          console.warn('[SHARE] dropped: not authenticated → UserAgree');
          navigationRef.navigate('UserAgree');
          resetShareIntent();
          return;
        }

        console.log('[SHARE] → ShareInbox', { files: payload.files.length });
        navigationRef.navigate('ShareInbox', { share: payload });
        // Clear so returning to the app later doesn't replay the same share.
        resetShareIntent();
      } finally {
        // Allow the next distinct share to be handled.
        handlingRef.current = false;
      }
    })();
    // Deps: primitives ONLY (a boolean + a content-derived string). The
    // shareIntent object and resetShareIntent are read through refs above,
    // precisely so their per-render identity can't restart-and-cancel this.
  }, [hasShareIntent, shareKey]);

  return null;
}
