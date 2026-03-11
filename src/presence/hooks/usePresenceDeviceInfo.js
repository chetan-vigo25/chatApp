import { useState } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';

export default function usePresenceDeviceInfo() {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);

  const updateDeviceInfo = async (info = {}) => {
    setIsLoading(true);
    try {
      const response = await socketService.emitDeviceUpdate(info);
      actions.setMyPresence({
        currentDevice: {
          ...state.myPresence.currentDevice,
          ...info,
        },
      });
      return response;
    } finally {
      setIsLoading(false);
    }
  };

  return {
    deviceInfo: state.myPresence.currentDevice,
    updateDeviceInfo,
    isLoading,
  };
}