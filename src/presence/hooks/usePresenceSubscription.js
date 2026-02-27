import { useMemo, useState } from 'react';
import * as socketService from '../services/presenceSocket.service';
import { usePresenceStore } from '../store/PresenceContext';

export default function usePresenceSubscription(userId) {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);

  const subscribe = async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      await socketService.emitSubscribe(userId);
      actions.updateContactPresence(userId, {
        subscription: { isSubscribed: true, subscribedAt: Date.now() },
      });
    } finally {
      setIsLoading(false);
    }
  };

  const unsubscribe = async () => {
    if (!userId) return;
    setIsLoading(true);
    try {
      await socketService.emitUnsubscribe(userId);
      actions.updateContactPresence(userId, {
        subscription: { isSubscribed: false, subscribedAt: null },
      });
    } finally {
      setIsLoading(false);
    }
  };

  const lastPresence = state.contactsPresence[userId] || null;

  return useMemo(() => ({
    isSubscribed: Boolean(lastPresence?.subscription?.isSubscribed),
    subscribe,
    unsubscribe,
    lastPresence,
    isLoading,
  }), [lastPresence, isLoading]);
}
