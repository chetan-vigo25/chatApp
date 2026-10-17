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
