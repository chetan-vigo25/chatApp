import { useEffect, useRef, useState } from 'react';

/**
 * useDelayedVisible — gate a transient "loading" UI (e.g. a skeleton) so it only
 * appears when a load is actually slow, and never flickers when it does appear.
 *
 *   const showSkeleton = useDelayedVisible(isLoading, { delay: 200, minVisible: 300 });
 *
 * Behaviour:
 *  - `active` true for LESS than `delay` ms  → never becomes visible (instant
 *    loads from SQLite go straight to content, no placeholder flash).
 *  - `active` still true after `delay` ms     → becomes visible.
 *  - once visible, stays visible for at least `minVisible` ms even if `active`
 *    flips false immediately after — so a load that resolves right after the
 *    threshold doesn't blink the skeleton on/off.
 *
 * Pure JS timers; no animation lib. Safe across unmount (timers cleared).
 */
export default function useDelayedVisible(active, { delay = 200, minVisible = 300 } = {}) {
  const [visible, setVisible] = useState(false);
  const delayTimer = useRef(null);
  const hideTimer = useRef(null);
  const shownAt = useRef(0);
  const visibleRef = useRef(false);

  useEffect(() => { visibleRef.current = visible; }, [visible]);

  useEffect(() => {
    if (active) {
      // A new load started (or is ongoing) — cancel any pending hide.
      if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
      // Arm the threshold timer once; if it survives `delay`, we show.
      if (!visibleRef.current && !delayTimer.current) {
        delayTimer.current = setTimeout(() => {
          delayTimer.current = null;
          shownAt.current = Date.now();
          setVisible(true);
        }, delay);
      }
    } else {
      // Load finished. If we never crossed the threshold, just disarm — no flash.
      if (delayTimer.current) { clearTimeout(delayTimer.current); delayTimer.current = null; }
      // If the skeleton is up, honour the minimum visible duration before hiding.
      if (visibleRef.current && !hideTimer.current) {
        const remaining = Math.max(0, minVisible - (Date.now() - shownAt.current));
        if (remaining === 0) {
          setVisible(false);
        } else {
          hideTimer.current = setTimeout(() => { hideTimer.current = null; setVisible(false); }, remaining);
        }
      }
    }
  }, [active, delay, minVisible]);

  // Clear timers on unmount.
  useEffect(() => () => {
    if (delayTimer.current) clearTimeout(delayTimer.current);
    if (hideTimer.current) clearTimeout(hideTimer.current);
  }, []);

  return visible;
}
