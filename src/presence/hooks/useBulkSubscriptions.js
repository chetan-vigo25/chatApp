import { useState } from 'react';
import * as socketService from '../services/presenceSocket.service';

export default function useBulkSubscriptions(userIds = []) {
  const [subscribed, setSubscribed] = useState([]);
  const [isLoading, setIsLoading] = useState(false);

  const subscribeMany = async (ids = []) => {
    if (!ids.length) return;
    setIsLoading(true);
    try {
      await socketService.emitSubscribe(null, ids);
      setSubscribed((prev) => Array.from(new Set([...prev, ...ids])));
    } finally {
      setIsLoading(false);
    }
  };

  const unsubscribeMany = async (ids = []) => {
    if (!ids.length) return;
    setIsLoading(true);
    try {
      await socketService.emitUnsubscribe(null, ids);
      setSubscribed((prev) => prev.filter((id) => !ids.includes(id)));
    } finally {
      setIsLoading(false);
    }
  };

  const subscribeAll = async () => subscribeMany(userIds);
  const unsubscribeAll = async () => unsubscribeMany(userIds);

  return {
    subscribed,
    subscribeMany,
    unsubscribeMany,
    subscribeAll,
    unsubscribeAll,
    isLoading,
  };
}
