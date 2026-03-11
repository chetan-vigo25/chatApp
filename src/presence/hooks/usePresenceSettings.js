import { useState } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';

const defaultSettings = {
  showLastSeen: true,
  showOnlineStatus: true,
  autoAway: true,
  autoAwayTimeout: 5,
  invisibleMode: false,
  customStatusEnabled: true,
  privacyLevel: 'contacts',
  readReceipts: true,
  typingIndicators: true,
};

export default function usePresenceSettings() {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);

  const updateSettings = async (newSettings = {}) => {
    setIsLoading(true);
    try {
      const response = await socketService.emitUpdateSettings(newSettings);
      actions.setSettings(newSettings);
      return response;
    } finally {
      setIsLoading(false);
    }
  };

  const resetToDefault = async () => updateSettings(defaultSettings);

  return {
    settings: state.settings,
    isLoading,
    updateSettings,
    resetToDefault,
  };
}