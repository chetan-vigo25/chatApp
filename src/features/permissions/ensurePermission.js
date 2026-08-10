import { Alert } from 'react-native';

import permissionManager from './data/PermissionManager';
import { getDescriptor, PERMISSION_IDS } from './domain/permissionCatalog';
import { PermissionStatus, isSatisfied, canRequest, isBlocked } from './domain/permissionTypes';

/**
 * ensurePermission — the ONE in-context permission gate every feature uses.
 *
 * The startup screen (PermissionsGate) asks for everything once, but denying there
 * must never permanently disable a feature. Whenever a feature that needs a
 * permission is actually used, it calls this helper, which:
 *
 *   1. reads the live OS status (no dialog);
 *   2. if it is already granted (or the OS has no such permission on this version)
 *      → proceeds immediately, never re-prompting;
 *   3. if the OS will still show its dialog (never asked, or denied but re-askable)
 *      → raises the REAL system dialog again, right there at the point of use;
 *   4. if the permission is permanently denied ("Don't ask again" / iOS second ask)
 *      → no dialog can appear, so it explains why and offers to open app Settings.
 *
 * That is exactly the behaviour the call flow already had for the microphone
 * (calls/CallProvider ensureMediaPermissions); this generalises it to every
 * permission so a denial at startup is always recoverable in context.
 *
 * CONTACTS IS DELIBERATELY NOT ROUTED THROUGH HERE. It is not in the catalog and
 * keeps its own in-context flow (contexts/useContactSync.js) untouched.
 *
 * It never fakes a grant: the boolean it returns always reflects what the OS said.
 */

/**
 * One shared promise per permission id while a check/request is in flight.
 * Two taps (or a screen that gates twice — e.g. the picker and a save action) must
 * not stack two system dialogs on top of each other; the second caller awaits the
 * first result. Only the OS round-trip is shared — each caller still applies its
 * own `purpose` / `silent` messaging to that result.
 * @type {Map<string, Promise<string>>}
 */
const inFlight = new Map();

/** Ids whose explanatory alert is currently on screen — see explain(). */
const explaining = new Set();
const EXPLAIN_DEBOUNCE_MS = 800;

/**
 * Fallback copy for permissions with no catalog descriptor.
 */
const FALLBACK = {
  title: 'Permission',
  description: 'This feature needs a device permission.',
  settingsHint: 'Enable this permission in Settings to use the feature.',
};

/**
 * @param {string} id  a PERMISSION_IDS value
 * @param {Object}  [options]
 * @param {string}  [options.purpose] one-line reason shown when the user denies —
 *                                    defaults to the catalog description
 * @param {boolean} [options.silent]  suppress the explanatory alerts (for
 *                                    best-effort background paths); the OS dialog
 *                                    is still raised when it can be
 * @returns {Promise<boolean>} true only when the OS reports the permission usable
 */
export async function ensurePermission(id, options = {}) {
  const { purpose, silent = false } = options;

  const status = await resolveStatus(id);
  if (isSatisfied(status)) return true;

  if (!silent) explain(id, status, purpose);
  return false;
}

/**
 * Check → (re-)request, deduplicated per id. Resolves to a PermissionStatus and
 * never rejects: a failure here must not crash the feature that asked.
 * @returns {Promise<string>}
 */
function resolveStatus(id) {
  const pending = inFlight.get(id);
  if (pending) return pending;

  const run = (async () => {
    try {
      const current = await permissionManager.check(id);
      // Already granted / limited / not a real permission on this OS → no dialog.
      if (isSatisfied(current)) return current;

      // Denied earlier (including at the startup screen) but still askable → ask
      // again, now that the user has reached the feature that needs it.
      if (canRequest(current)) return await permissionManager.request(id);

      return current;
    } catch (error) {
      console.warn(`[permissions] ensurePermission(${id}) failed:`, error?.message);
      return PermissionStatus.DENIED;
    }
  })();

  inFlight.set(id, run);
  run.then(
    () => { if (inFlight.get(id) === run) inFlight.delete(id); },
    () => { if (inFlight.get(id) === run) inFlight.delete(id); },
  );
  return run;
}

/**
 * Passive read for UI that wants to reflect the current state without prompting.
 * @returns {Promise<boolean>}
 */
export async function hasPermission(id) {
  return isSatisfied(await permissionManager.check(id));
}

/**
 * Tell the user what just happened and, when only Settings can fix it, take them
 * there. A plain deny gets an informational alert — retrying the feature re-asks.
 */
function explain(id, status, purpose) {
  // Two gates resolving from the same shared OS round-trip (a double tap, or a
  // screen that checks twice) must not stack two identical alerts.
  if (explaining.has(id)) return;
  explaining.add(id);
  setTimeout(() => explaining.delete(id), EXPLAIN_DEBOUNCE_MS);

  const descriptor = getDescriptor(id) || FALLBACK;
  const title = descriptor.title || FALLBACK.title;
  const reason = purpose || descriptor.description || FALLBACK.description;

  if (isBlocked(status)) {
    Alert.alert(
      `${title} is blocked`,
      `${reason}\n\n${descriptor.settingsHint || FALLBACK.settingsHint}`,
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Open Settings', onPress: () => { permissionManager.openSettings(); } },
      ],
    );
    return;
  }

  Alert.alert(`${title} permission needed`, reason);
}

export { PERMISSION_IDS };
