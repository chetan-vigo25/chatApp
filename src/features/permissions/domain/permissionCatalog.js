/**
 * Permission catalog — the single source of truth for WHAT the startup permission
 * screen shows, in WHICH order, and WHY each permission is needed.
 *
 * This file is pure presentation metadata: no OS calls live here. Each entry points
 * at an adapter (`data/adapters`) by id, which keeps the catalog open for extension
 * (add an entry + an adapter) and closed for modification (nothing else changes).
 *
 * ── Play Store / App Store notes ────────────────────────────────────────────────
 * • Every entry carries a user-facing reason. Google Play's User Data policy and
 *   Apple review guideline 5.1.1 both require the purpose to be obvious BEFORE the
 *   system dialog appears — that is exactly what this screen does.
 * • CONTACTS IS DELIBERATELY ABSENT. Contacts stays an in-context request, fired
 *   only when the contacts feature is used (see contexts/useContactSync.js).
 *   Do not add it here.
 * • `required: true` means the Continue button stays disabled until the permission
 *   is satisfied. If a store reviewer ever objects to gating app entry on a
 *   non-core permission (Location is the usual candidate), flip that ONE flag to
 *   `false` — the row still renders and can still be granted, it just stops
 *   blocking Continue. No other code needs to change.
 */

export const PERMISSION_IDS = Object.freeze({
  NOTIFICATIONS: 'notifications',
  CAMERA: 'camera',
  PHOTOS: 'photos',
  MICROPHONE: 'microphone',
  FILES: 'files',
  LOCATION: 'location',
});

/**
 * Ordered list — the order the rows are shown in, running from most-expected to
 * least-expected. Each row is asked individually when its own Allow is tapped;
 * nothing is requested automatically.
 *
 * @typedef {Object} PermissionDescriptor
 * @property {string} id            Adapter key — see data/adapters/index.js
 * @property {string} title         Row title
 * @property {string} description   Short "why we need it" line shown under the title
 * @property {string} icon          Ionicons glyph name
 * @property {string} accent        Row icon tint (chip background is derived from it)
 * @property {boolean} required     Blocks the Continue button until satisfied
 * @property {string} settingsHint  Guidance shown when permanently denied
 */
export const PERMISSION_CATALOG = Object.freeze([
  {
    id: PERMISSION_IDS.NOTIFICATIONS,
    title: 'Notifications',
    description: 'Receive messages, calls and important updates.',
    icon: 'chatbubble-ellipses',
    accent: '#3B82F6',
    required: true,
    settingsHint: 'Turn on Notifications to keep receiving new messages and incoming calls.',
  },
  {
    id: PERMISSION_IDS.CAMERA,
    title: 'Camera',
    description: 'Take photos and videos to share in chats.',
    icon: 'camera',
    accent: '#22C55E',
    required: true,
    settingsHint: 'Enable Camera access to capture photos, videos and make video calls.',
  },
  {
    id: PERMISSION_IDS.PHOTOS,
    title: 'Photos & Videos',
    description: 'Select and share media with your contacts.',
    icon: 'images',
    accent: '#8B5CF6',
    required: true,
    settingsHint: 'Enable Photos access to pick and save media from your library.',
  },
  {
    id: PERMISSION_IDS.MICROPHONE,
    title: 'Microphone',
    description: 'Record voice messages and make voice calls.',
    icon: 'mic',
    accent: '#F97316',
    required: true,
    settingsHint: 'Enable Microphone access to record voice notes and talk on calls.',
  },
  {
    id: PERMISSION_IDS.FILES,
    title: 'Files & Storage',
    description: 'Send and receive documents and files.',
    icon: 'folder',
    accent: '#F59E0B',
    required: true,
    settingsHint: 'Enable Files access to attach and open documents.',
  },
  {
    id: PERMISSION_IDS.LOCATION,
    title: 'Location',
    description: 'Share your current location in a chat.',
    icon: 'location',
    accent: '#14B8A6',
    required: true,
    settingsHint: 'Enable Location access to share where you are from the attachment menu.',
  },
]);

/** Lookup helper — O(n) over a 6-item frozen array, no memoization needed. */
export function getDescriptor(id) {
  return PERMISSION_CATALOG.find((entry) => entry.id === id) || null;
}
