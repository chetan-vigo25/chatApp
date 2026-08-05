import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';

import permissionManager from '../data/PermissionManager';
import { markOnboardingCompleted } from '../data/permissionStorage';
import { releaseNotificationPrompt } from '../notificationPromptGate';
import { PermissionStatus, isSatisfied, isBlocked, canRequest } from '../domain/permissionTypes';

/**
 * usePermissionFlow — the view model (MVVM) behind the Permission Introduction
 * screen. It owns ALL flow state and decisions; the screen is a pure rendering of
 * what this hook exposes and does nothing but forward user intent back into it.
 *
 * Guarantees:
 *   • every "Allow" tap ends in a real OS dialog (via PermissionManager) — the flow
 *     has no way to mark something granted on its own;
 *   • ONE tap asks ONE permission — the flow never auto-advances to the next one;
 *   • already-granted permissions are skipped, never re-asked;
 *   • a permanently denied permission offers the Settings recovery path instead of
 *     re-prompting;
 *   • state updates are lifecycle-safe — nothing is written after unmount;
 *   • returning from system Settings re-reads every status automatically.
 */
export default function usePermissionFlow() {
  // Fixed for the lifetime of the screen: which permissions exist on this device.
  const descriptors = useMemo(() => permissionManager.listApplicable(), []);

  const [statuses, setStatuses] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const mountedRef = useRef(true);
  const runningRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** Passive re-read of every status. Never shows a dialog. */
  const refresh = useCallback(async () => {
    try {
      const next = await permissionManager.checkAll();
      if (!mountedRef.current) return next;
      setStatuses(next);
      setError(null);
      return next;
    } catch (err) {
      if (mountedRef.current) setError('Unable to read permission status.');
      return {};
    } finally {
      if (mountedRef.current) setIsLoading(false);
    }
  }, []);

  // Initial read.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-read whenever the app comes back to the foreground — this is how a permission
  // granted in system Settings shows up here without the user having to restart.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const returning = appStateRef.current.match(/inactive|background/) && nextState === 'active';
      appStateRef.current = nextState;
      if (returning) refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  /**
   * Request EXACTLY the permission the user tapped Allow on — nothing else.
   *
   * Strictly one tap → one native dialog. The flow never advances to the next
   * permission on its own: the user stays in control of which permission is asked
   * and when, which is also the behaviour both stores prefer (no dialog chains the
   * user did not initiate).
   *
   * Already-granted and permanently-denied rows are skipped without a dialog — the
   * UI never offers Allow in those states anyway, this is the belt-and-braces guard.
   */
  const requestOne = useCallback(
    async (id) => {
      if (runningRef.current) return;

      const descriptor = descriptors.find((entry) => entry.id === id);
      if (!descriptor) return;

      runningRef.current = true;

      try {
        // Re-read this one permission first: it may have been granted from Settings
        // (or implied by another grant) since the list was last refreshed, and a
        // permission that is already satisfied must never be asked again.
        const currentStatus = await permissionManager.check(id);
        if (!mountedRef.current) return;

        setStatuses((prev) => ({ ...prev, [id]: currentStatus }));
        if (!canRequest(currentStatus)) return;

        setBusyId(id);
        const status = await permissionManager.request(id);
        if (!mountedRef.current) return;

        setStatuses((prev) => ({ ...prev, [id]: status }));
      } catch (err) {
        if (mountedRef.current) setError('Something went wrong while requesting permission.');
      } finally {
        runningRef.current = false;
        if (mountedRef.current) setBusyId(null);

        // Passive sweep of every row. On Android below 13 a single OS permission can
        // back more than one row (legacy storage covers both media and documents),
        // so one grant can satisfy another without us having asked for it.
        if (mountedRef.current) refresh();
      }
    },
    [descriptors, refresh],
  );

  /** Send the user to the app's system settings page, then re-read on return. */
  const openSettings = useCallback(async () => {
    await permissionManager.openSettings();
  }, []);

  /** Persist completion so the screen is never forced on this user again. */
  const completeFlow = useCallback(async () => {
    releaseNotificationPrompt();
    await markOnboardingCompleted();
  }, []);

  // ── Derived view state ────────────────────────────────────────────────────────
  const items = useMemo(
    () =>
      descriptors.map((entry) => ({
        ...entry,
        status: statuses[entry.id] || PermissionStatus.UNDETERMINED,
        isSatisfied: isSatisfied(statuses[entry.id]),
        isBlocked: isBlocked(statuses[entry.id]),
        isBusy: busyId === entry.id,
      })),
    [descriptors, statuses, busyId],
  );

  const allRequiredGranted = useMemo(
    () => !isLoading && permissionManager.areRequiredSatisfied(statuses),
    [statuses, isLoading],
  );

  const blockedItems = useMemo(() => items.filter((item) => item.isBlocked), [items]);

  const pendingCount = useMemo(
    () => items.filter((item) => item.required && !item.isSatisfied).length,
    [items],
  );

  return {
    items,
    isLoading,
    isWorking: busyId !== null,
    error,
    allRequiredGranted,
    blockedItems,
    pendingCount,
    requestOne,
    openSettings,
    completeFlow,
    refresh,
  };
}
