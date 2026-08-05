/**
 * Permissions feature — public surface.
 *
 * Layers (clean architecture):
 *   domain/     → status vocabulary + the catalog of what we ask for and why
 *   data/       → OS adapters, the reusable PermissionManager, persistence
 *   viewmodel/  → usePermissionFlow, the MVVM state machine for the intro screen
 *   ui/, screens/ → presentation only
 *
 * Consumers outside this folder should import from here, not from internal paths.
 */
export { default as PermissionsScreen } from './screens/PermissionsScreen';
export { default as permissionManager } from './data/PermissionManager';
export { default as usePermissionFlow } from './viewmodel/usePermissionFlow';
export { shouldShowPermissionIntro } from './permissionBootstrap';
export { PERMISSION_IDS, PERMISSION_CATALOG } from './domain/permissionCatalog';
export { PermissionStatus, isSatisfied, isBlocked, canRequest } from './domain/permissionTypes';
export { resetOnboarding as resetPermissionOnboarding } from './data/permissionStorage';
export { isNotificationPromptHeld, releaseNotificationPrompt } from './notificationPromptGate';
