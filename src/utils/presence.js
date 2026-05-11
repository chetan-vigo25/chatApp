export const PRESENCE_STATUS = {
  ONLINE: 'online',
  AWAY: 'away',
  BUSY: 'busy',
  OFFLINE: 'offline',
};

const VALID_STATUS = new Set(Object.values(PRESENCE_STATUS));

export const normalizeStatus = (status) => {
  if (!status || typeof status !== 'string') return PRESENCE_STATUS.OFFLINE;
  const normalized = status.toLowerCase();
  return VALID_STATUS.has(normalized) ? normalized : PRESENCE_STATUS.OFFLINE;
};

export const normalizePresencePayload = (payload = {}) => {
  const source = payload?.data && typeof payload.data === 'object' ? payload.data : payload;

  const status = normalizeStatus(
    source.status ||
    source.effectiveStatus ||
    source.manualStatus ||
    source.presenceStatus
  );

  return {
    userId: source.userId || source.id || null,
    status,
    lastSeen: source.lastSeen || null,
    updatedAt: source.updatedAt || source.lastUpdated || Date.now(),
    customStatus: source.customStatus || source.manualCustomStatus || '',
    expiresAt: source.expiresAt || source.manualExpiresAt || null,
    manualOverride: Boolean(source.manualOverride),
    manualStatus: source.manualStatus || '',
    manualExpiresAt: source.manualExpiresAt || null,
    metadata: source.metadata || {},
  };
};

export const getPresenceText = ({ status, lastSeen, customStatus }) => {
  const normalized = normalizeStatus(status);
  if (normalized === PRESENCE_STATUS.ONLINE) {
    return customStatus ? `online • ${customStatus}` : 'online';
  }
  if (normalized === PRESENCE_STATUS.AWAY) {
    return customStatus ? `away • ${customStatus}` : 'away';
  }
  if (normalized === PRESENCE_STATUS.BUSY) {
    return customStatus ? `busy • ${customStatus}` : 'busy';
  }
  if (lastSeen) return lastSeen;
  return 'offline';
};
