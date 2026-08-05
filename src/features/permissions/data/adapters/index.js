import notificationsAdapter from './notificationsAdapter';
import cameraAdapter from './cameraAdapter';
import photosAdapter from './photosAdapter';
import microphoneAdapter from './microphoneAdapter';
import filesAdapter from './filesAdapter';
import locationAdapter from './locationAdapter';

/**
 * Adapter registry — the ONLY place in the app that knows which SDK backs which
 * permission. Everything above this layer talks to the PermissionManager in terms of
 * catalog ids and normalized {@link PermissionStatus} values.
 *
 * Every adapter implements the same tiny interface (Liskov-substitutable):
 *   { id: string,
 *     isSupported(): boolean,        // is this permission real on THIS OS version?
 *     check(): Promise<PermissionStatus>,   // passive — never shows a dialog
 *     request(): Promise<PermissionStatus>  // shows the NATIVE OS dialog
 *   }
 *
 * Adding a permission = add an adapter here + a catalog entry. Nothing else changes.
 */
const adapterRegistry = Object.freeze({
  [notificationsAdapter.id]: notificationsAdapter,
  [cameraAdapter.id]: cameraAdapter,
  [photosAdapter.id]: photosAdapter,
  [microphoneAdapter.id]: microphoneAdapter,
  [filesAdapter.id]: filesAdapter,
  [locationAdapter.id]: locationAdapter,
});

export default adapterRegistry;
