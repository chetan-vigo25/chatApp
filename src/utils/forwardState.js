// Shared state for forward message tracking.
// Set by ForwardMessageScreen, read by useChatLogic.
let _lastForwardTimestamp = 0;

export const setForwardTimestamp = () => {
  _lastForwardTimestamp = Date.now();
};

export const getForwardTimestamp = () => _lastForwardTimestamp;

export const clearForwardTimestamp = () => {
  _lastForwardTimestamp = 0;
};

export const isInForwardWindow = (windowMs = 15000) => {
  return _lastForwardTimestamp > 0 && (Date.now() - _lastForwardTimestamp) < windowMs;
};
