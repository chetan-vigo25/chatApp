import { useEffect, useRef } from 'react';
import { useShareIntentContext } from 'expo-share-intent';

import { navigationRef } from '../Redux/Services/navigationService';
import { getStoredSession } from '../services/sessionManager';
import { normalizeShare } from './ShareManager';

/**
 * ShareIntentGate — routes an incoming OS share into the app.
 *
 *   OS share sheet → (this) → auth check → ShareInbox (chat picker)
 *                              → ChatScreen → existing sendMedia pipeline
 *
 * Mounted once, inside NavigationContainer (so navigationRef is ready). Renders
 * nothing. It only fires when the app is opened FROM a share; normal launches are
 * untouched.
 *
 * Auth-gated: an unauthenticated user is sent to onboarding and the share is
 * dropped (a logged-out user has no chat to send to). Uses the same
 * getStoredSession() check Splash uses, so behaviour matches the rest of the app.
 */
export default function ShareIntentGate() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const handlingRef = useRef(false);

  useEffect(() => {
    if (!hasShareIntent || handlingRef.current) return;
    handlingRef.current = true;

    let cancelled = false;

    (async () => {
      try {
        const payload = normalizeShare(shareIntent);

        // Nothing usable came through — clear and bail.
        if (!payload.files.length && !payload.text) {
          resetShareIntent();
          return;
        }

        // Wait until navigation is actually ready (cold start via share can fire
        // this before the container mounts).
        for (let i = 0; i < 40 && !navigationRef.isReady(); i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 100));
          if (cancelled) return;
        }
        if (cancelled || !navigationRef.isReady()) return;

        const session = await getStoredSession();
        const authed = !!(session?.userInfo && session?.accessToken);
        if (cancelled) return;

        if (!authed) {
          navigationRef.navigate('UserAgree');
          resetShareIntent();
          return;
        }

        navigationRef.navigate('ShareInbox', { share: payload });
        // Clear so returning to the app later doesn't replay the same share.
        resetShareIntent();
      } finally {
        // Allow the next distinct share to be handled.
        handlingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  return null;
}
