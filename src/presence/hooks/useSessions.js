import { useState } from 'react';
import { usePresenceStore } from '../store/PresenceContext';
import * as socketService from '../services/presenceSocket.service';

export default function useSessions() {
  const { state, actions } = usePresenceStore();
  const [isLoading, setIsLoading] = useState(false);

  const listSessions = async () => {
    setIsLoading(true);
    try {
      const response = await socketService.emitListSessions();
      actions.setSessions(response?.data || []);
      return response;
    } finally {
      setIsLoading(false);
    }
  };

  const terminateSession = async (sessionId) => {
    if (!sessionId) return null;
    const response = await socketService.emitTerminateSession(sessionId);
    await listSessions();
    return response;
  };

  const terminateOtherSessions = async () => {
    const current = state.sessions.currentSessionId;
    const others = (state.sessions.sessions || []).filter((item) => item.sessionId !== current);
    for (const item of others) {
      await socketService.emitTerminateSession(item.sessionId);
    }
    return listSessions();
  };

  const renameCurrentSession = async (name) => {
    const response = await socketService.emitRenameSession(name);
    await listSessions();
    return response;
  };

  return {
    sessions: state.sessions.sessions,
    currentSession: state.sessions.sessions.find((session) => session.isCurrent) || null,
    isLoading: isLoading || state.sessions.isLoading,
    listSessions,
    terminateSession,
    terminateOtherSessions,
    renameCurrentSession,
    refresh: listSessions,
  };
}