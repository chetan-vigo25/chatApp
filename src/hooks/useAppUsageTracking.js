import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { emitSocketEvent } from '../Redux/Services/Socket/socket';
import {
  subscribeNavigationSnapshot,
  getCurrentRouteSnapshot,
} from '../Redux/Services/navigationService';

// Periodically flush so long single sessions aren't lost if the app is killed.
const FLUSH_INTERVAL_MS = 120000; // 2 min

const localDate = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Tracks app usage (foreground duration, opens, sessions) and screen behaviour
 * (time + views per screen), flushing DELTA rollups to the backend via the
 * existing socket (`usage:flush`). The backend folds them into the daily
 * AppUsageDaily / UserBehaviourDaily docs with $inc.
 *
 * Mount once from an always-mounted, post-auth provider (RealtimeChatProvider),
 * gated on `enabled = !!userId`.
 */
export const useAppUsageTracking = (enabled = true) => {
  const pending = useRef({ foregroundMs: 0, openCount: 0, sessionCount: 0, screens: {} });
  const lastResume = useRef(Date.now());
  const screenStart = useRef(Date.now());
  const activeScreen = useRef(null);
  const isActive = useRef(true);

  useEffect(() => {
    if (!enabled) return undefined;

    let flushTimer = null;
    let appStateSub = null;
    let navUnsub = null;

    const bumpViews = (name) => {
      if (!name) return;
      const s = pending.current.screens[name] || (pending.current.screens[name] = { durationMs: 0, views: 0 });
      s.views += 1;
    };
    const addDuration = (name, ms) => {
      if (!name || ms <= 0) return;
      const s = pending.current.screens[name] || (pending.current.screens[name] = { durationMs: 0, views: 0 });
      s.durationMs += ms;
    };

    // Fold time elapsed since the last marker into foreground + current screen,
    // then reset the markers to now. Only counts while in the foreground.
    const accumulate = () => {
      if (!isActive.current) return;
      const now = Date.now();
      const elapsed = now - lastResume.current;
      if (elapsed > 0) pending.current.foregroundMs += elapsed;
      if (activeScreen.current) addDuration(activeScreen.current, now - screenStart.current);
      lastResume.current = now;
      screenStart.current = now;
    };

    const flush = (force = false) => {
      accumulate();
      const p = pending.current;
      const hasData =
        p.foregroundMs > 0 || p.openCount > 0 || p.sessionCount > 0 || Object.keys(p.screens).length > 0;
      if (!hasData && !force) return;

      const screens = Object.entries(p.screens).map(([name, v]) => ({
        name,
        durationMs: v.durationMs,
        views: v.views,
      }));
      emitSocketEvent(
        'usage:flush',
        { date: localDate(), foregroundMs: p.foregroundMs, openCount: p.openCount, sessionCount: p.sessionCount, screens },
        undefined,
        { queueIfOffline: true },
      );
      pending.current = { foregroundMs: 0, openCount: 0, sessionCount: 0, screens: {} };
    };

    // ── cold start: begin a usage session ──
    isActive.current = AppState.currentState === 'active';
    pending.current.openCount += 1;
    pending.current.sessionCount += 1;
    lastResume.current = Date.now();
    screenStart.current = Date.now();
    activeScreen.current = getCurrentRouteSnapshot()?.name || null;
    if (activeScreen.current) bumpViews(activeScreen.current);

    // ── screen changes ──
    navUnsub = subscribeNavigationSnapshot((route) => {
      const name = route?.name || null;
      if (name === activeScreen.current) return;
      if (activeScreen.current && isActive.current) {
        addDuration(activeScreen.current, Date.now() - screenStart.current);
      }
      activeScreen.current = name;
      screenStart.current = Date.now();
      if (name) bumpViews(name);
    });

    // ── foreground / background ──
    appStateSub = AppState.addEventListener('change', (next) => {
      const leavingForeground = isActive.current && /inactive|background/.test(next);
      const enteringForeground = !isActive.current && next === 'active';

      if (leavingForeground) {
        flush(); // folds elapsed time while still marked active, then sends
        isActive.current = false;
      } else if (enteringForeground) {
        isActive.current = true;
        lastResume.current = Date.now();
        screenStart.current = Date.now();
        pending.current.openCount += 1;
        pending.current.sessionCount += 1;
        activeScreen.current = getCurrentRouteSnapshot()?.name || activeScreen.current;
        if (activeScreen.current) bumpViews(activeScreen.current);
      }
    });

    flushTimer = setInterval(() => flush(), FLUSH_INTERVAL_MS);

    return () => {
      if (flushTimer) clearInterval(flushTimer);
      if (appStateSub) appStateSub.remove();
      if (navUnsub) navUnsub();
      flush(); // final flush on logout/unmount
    };
  }, [enabled]);
};

export default useAppUsageTracking;
