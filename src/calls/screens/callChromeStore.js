/**
 * Video-call "chrome" (top bar + control row) visibility, shared between the
 * two layers that need it: CallOverlay draws the chrome and owns the 8s
 * auto-hide timer, while NativeVideoStage sits UNDER the overlay and owns the
 * tap-anywhere-to-toggle surface (it has to — a full-screen touch layer in the
 * overlay would sit on top of the draggable self tile and swallow its drag
 * and tap-to-swap). Plain module state + subscribers, like streamRegistry.
 */
import { useSyncExternalStore } from 'react';

let visible = true;
const subs = new Set();

export const getChromeVisible = () => visible;

export const setChromeVisible = (v) => {
  const next = !!v;
  if (visible === next) return;
  visible = next;
  subs.forEach((fn) => { try { fn(); } catch { /* subscriber error */ } });
};

export const toggleChrome = () => setChromeVisible(!visible);

export const subscribeChrome = (fn) => {
  subs.add(fn);
  return () => { subs.delete(fn); };
};

export const useChromeVisible = () => useSyncExternalStore(subscribeChrome, getChromeVisible);

// GROUP video only: true while one tile is SPOTLIGHTED (tapped big, or an
// auto-focused screen share). The gallery grid already insets itself between
// the top bar and the controls, so hiding the chrome there only leaves empty
// bars — CallOverlay auto-hides the chrome only in the spotlight view, where
// the big tile grows into the freed space.
let stageFocused = false;
const focusSubs = new Set();

export const setStageFocused = (v) => {
  const next = !!v;
  if (stageFocused === next) return;
  stageFocused = next;
  focusSubs.forEach((fn) => { try { fn(); } catch { /* subscriber error */ } });
};

const subscribeFocus = (fn) => {
  focusSubs.add(fn);
  return () => { focusSubs.delete(fn); };
};

export const useStageFocused = () => useSyncExternalStore(subscribeFocus, () => stageFocused);
