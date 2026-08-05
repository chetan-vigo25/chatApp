import { Platform, Linking, AppState } from 'react-native';

import adapterRegistry from './adapters';
import { PERMISSION_CATALOG } from '../domain/permissionCatalog';
import { PermissionStatus, isSatisfied, canRequest } from '../domain/permissionTypes';
import { loadStatusMemory, rememberStatus } from './permissionStorage';
import { suspendAppLock, resumeAppLock } from '../../../services/appLockGuard';

/**
 * PermissionManager — the reusable, UI-agnostic permission service.
 *
 * Responsibilities (and nothing else):
 *   • resolve which catalog entries actually apply to the running OS version
 *   • read statuses passively (never pops a dialog)
 *   • request a permission through the NATIVE OS dialog
 *   • remember a permanent denial so the UI can offer Settings instead of a dead
 *     Allow button
 *   • open the app's system settings page
 *
 * It has no React dependency, so it can be used from any screen, hook or service —
 * the startup flow is just its first consumer.
 */
class PermissionManager {
  constructor(registry, catalog) {
    this._registry = registry;
    this._catalog = catalog;
    /** @type {Record<string, string>|null} lazily loaded blocked-memory cache */
    this._memory = null;
  }

  _adapter(id) {
    return this._registry[id] || null;
  }

  async _memoryFor(id) {
    if (!this._memory) this._memory = await loadStatusMemory();
    return this._memory[id];
  }

  /**
   * Catalog entries whose permission genuinely exists on this device.
   * Rows the OS has no concept of (legacy storage on Android 13+, POST_NOTIFICATIONS
   * on Android 12 and below) are filtered out rather than shown as inert.
   */
  listApplicable() {
    // The web build has no runtime permission model to introduce — returning an
    // empty set makes the startup gate resolve to "nothing to ask" and skip the
    // screen entirely, exactly like a fully-granted device.
    if (Platform.OS === 'web') return [];

    return this._catalog.filter((entry) => {
      const adapter = this._adapter(entry.id);
      return !!adapter && adapter.isSupported();
    });
  }

  /**
   * Passive status read — safe from any context, never shows a dialog.
   * Layers the remembered "permanently denied" verdict on top of the live result,
   * because some platform APIs cannot report `canAskAgain` on a passive check.
   */
  async check(id) {
    const adapter = this._adapter(id);
    if (!adapter) return PermissionStatus.UNAVAILABLE;
    if (!adapter.isSupported()) return PermissionStatus.UNAVAILABLE;

    try {
      const status = await adapter.check();
      if (isSatisfied(status)) return status;

      const remembered = await this._memoryFor(id);
      return remembered === PermissionStatus.BLOCKED ? PermissionStatus.BLOCKED : status;
    } catch (error) {
      console.warn(`[permissions] check(${id}) failed:`, error?.message);
      return PermissionStatus.UNDETERMINED;
    }
  }

  /** Read every applicable permission at once. @returns {Promise<Record<string,string>>} */
  async checkAll() {
    const entries = this.listApplicable();
    const statuses = await Promise.all(entries.map((entry) => this.check(entry.id)));

    return entries.reduce((acc, entry, index) => {
      acc[entry.id] = statuses[index];
      return acc;
    }, {});
  }

  /**
   * Show the REAL operating-system permission dialog. There is no code path in this
   * class that reports a grant without the OS having actually granted it.
   *
   * The call is wrapped in the app-lock guard: on some OEMs a permission dialog
   * briefly takes focus away from the activity, which the 2-step app lock would
   * otherwise read as "returned from background" and re-lock over the top.
   *
   * @returns {Promise<string>} the resulting PermissionStatus
   */
  async request(id) {
    const adapter = this._adapter(id);
    if (!adapter || !adapter.isSupported()) return PermissionStatus.UNAVAILABLE;

    // Android throws `Tried to use permissions API while not attached to an Activity`
    // if a dialog is requested with no foreground activity. Never let that crash the
    // flow — report the current status and let the user retry when focused.
    if (Platform.OS === 'android' && AppState.currentState !== 'active') {
      return this.check(id);
    }

    suspendAppLock();
    try {
      const status = await adapter.request();
      this._memory = { ...(this._memory || {}) };
      if (status === PermissionStatus.BLOCKED) this._memory[id] = status;
      else delete this._memory[id];
      await rememberStatus(id, status);
      return status;
    } catch (error) {
      console.warn(`[permissions] request(${id}) failed:`, error?.message);
      return this.check(id);
    } finally {
      resumeAppLock();
    }
  }

  /**
   * Fire the NATIVE OS permission dialog for every applicable permission, one at a
   * time, in catalog order. Used by the startup flow: right after Splash the app
   * asks each permission via the real Android/iOS system dialog — no custom UI in
   * between.
   *
   * Rules kept intact:
   *   • already-granted permissions are skipped (never re-asked);
   *   • permanently-denied ones are skipped (no dialog can appear — no spam);
   *   • each dialog is awaited before the next, so they never stack;
   *   • it NEVER fakes a grant — a skipped/denied permission stays exactly what the
   *     OS reports.
   *
   * @param {(id: string, status: string) => void} [onProgress] optional per-step cb
   * @returns {Promise<Record<string, string>>} id → resulting PermissionStatus
   */
  async requestAllSequentially(onProgress) {
    const results = {};

    for (const entry of this.listApplicable()) {
      // Read the live status first — only raise a dialog when the OS will actually
      // show one (undetermined / re-askable denied). Granted or blocked → skip.
      let status = await this.check(entry.id);
      if (canRequest(status)) {
        status = await this.request(entry.id);
      }
      results[entry.id] = status;
      if (typeof onProgress === 'function') {
        try { onProgress(entry.id, status); } catch (_) {}
      }
    }

    return results;
  }

  /** True when every `required: true` applicable permission is satisfied. */
  areRequiredSatisfied(statuses = {}) {
    return this.listApplicable()
      .filter((entry) => entry.required)
      .every((entry) => isSatisfied(statuses[entry.id]));
  }

  /**
   * Open this app's page in system Settings — the only recovery path once a
   * permission is permanently denied.
   */
  async openSettings() {
    suspendAppLock();
    try {
      if (Platform.OS === 'ios') {
        // `app-settings:` is the documented deep link and is more reliable than
        // openSettings() on older iOS versions; fall back if it is unavailable.
        await Linking.openURL('app-settings:').catch(() => Linking.openSettings());
      } else {
        await Linking.openSettings();
      }
      return true;
    } catch (error) {
      console.warn('[permissions] openSettings failed:', error?.message);
      return false;
    } finally {
      // Longer grace: the user is leaving the app entirely and may take a while.
      resumeAppLock(2500);
    }
  }
}

/** App-wide singleton — permission state is device state, not screen state. */
const permissionManager = new PermissionManager(adapterRegistry, PERMISSION_CATALOG);

export default permissionManager;
export { PermissionManager };
