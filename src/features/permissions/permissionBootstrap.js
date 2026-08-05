import permissionManager from './data/PermissionManager';
import { isOnboardingCompleted, markOnboardingCompleted } from './data/permissionStorage';
import { releaseNotificationPrompt } from './notificationPromptGate';

/**
 * Startup gate used by the Splash screen.
 *
 * Decides — before any UI is shown — whether the Permission Introduction screen is
 * needed at all:
 *
 *   • Returning user who already finished the flow → skip. The screen is a one-time
 *     introduction, not a recurring wall; individual features re-ask in context if a
 *     permission is revoked later. This is also what guarantees a user can never be
 *     locked out of their chats by a permission they turned off in Settings.
 *   • First run where the OS already reports every required permission as granted
 *     (common after a reinstall, or a restored backup) → mark the flow complete and
 *     skip. "Do not ask again for something already granted."
 *   • Anything else → show the screen.
 *
 * Failing safe means SKIPPING: a storage or OS hiccup must never wedge the user on a
 * permission screen they cannot get past.
 *
 * @returns {Promise<boolean>} true when the intro screen should be presented
 */
export async function shouldShowPermissionIntro() {
  try {
    if (await isOnboardingCompleted()) {
      releaseNotificationPrompt();
      return false;
    }

    const statuses = await permissionManager.checkAll();
    if (permissionManager.areRequiredSatisfied(statuses)) {
      await markOnboardingCompleted();
      releaseNotificationPrompt();
      return false;
    }

    // The permission screen now owns the notification prompt.
    return true;
  } catch (error) {
    console.warn('[permissions] bootstrap failed, skipping intro:', error?.message);
    releaseNotificationPrompt();
    return false;
  }
}
