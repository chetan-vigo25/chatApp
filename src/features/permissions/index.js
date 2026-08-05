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
 * by its own feature; the admin location-tracking consent is a separate later flow.
 *
 * Consumers outside this folder should import from here, not from internal paths.
 */
export { default as PermissionsGate } from './screens/PermissionsGate';
export { default as permissionManager } from './data/PermissionManager';
export { shouldShowPermissionIntro } from './permissionBootstrap';
export { PERMISSION_IDS, PERMISSION_CATALOG } from './domain/permissionCatalog';
export { PermissionStatus, isSatisfied, isBlocked, canRequest } from './domain/permissionTypes';
export { resetOnboarding as resetPermissionOnboarding } from './data/permissionStorage';
export { isNotificationPromptHeld, releaseNotificationPrompt } from './notificationPromptGate';
