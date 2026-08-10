/**
 * Permissions feature — public surface.
 *
 * Layers (clean architecture):
 *   domain/     → status vocabulary + the catalog of what we ask for and why
 *   data/       → OS adapters, the reusable PermissionManager, persistence
 *   screens/    → PermissionsGate: fires the native OS dialogs after Splash
 *
 * The startup step has NO custom "Allow" UI — it raises the real Android/iOS
 * permission dialogs directly (see PermissionsGate). Contacts is asked in context
 * by its own feature.
 *
 * Denying at startup is never final: every feature gates itself with
 * `ensurePermission(id)` (see ensurePermission.js), which re-raises the real OS
 * dialog at the point of use and falls back to a Settings prompt once the OS
 * refuses to ask again.
 *
 * Consumers outside this folder should import from here, not from internal paths.
 */
export { default as PermissionsGate } from './screens/PermissionsGate';
export { default as permissionManager } from './data/PermissionManager';
export { ensurePermission, hasPermission } from './ensurePermission';
export { shouldShowPermissionIntro } from './permissionBootstrap';
export { PERMISSION_IDS, PERMISSION_CATALOG } from './domain/permissionCatalog';
export { PermissionStatus, isSatisfied, isBlocked, canRequest } from './domain/permissionTypes';
export { resetOnboarding as resetPermissionOnboarding } from './data/permissionStorage';
export { isNotificationPromptHeld, releaseNotificationPrompt } from './notificationPromptGate';
