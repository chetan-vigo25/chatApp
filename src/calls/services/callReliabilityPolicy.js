// Pure policy for the call-reliability prompt (P-C-08/09/10). CommonJS and
// dependency-free so it is unit-testable with node:test; callReliability.js
// feeds it the native reads.

// Manufacturers whose skins gate background start behind an "Autostart" /
// "Startup manager" toggle that cannot be queried — the only honest approach is
// to point the user at it once per install.
const AUTOSTART_OEMS = [
  'xiaomi', 'redmi', 'poco', 'oppo', 'realme', 'oneplus', 'vivo', 'iqoo',
  'huawei', 'honor', 'letv', 'asus',
];

const isAutoStartOem = (manufacturer) => {
  const m = String(manufacturer || '').trim().toLowerCase();
  return !!m && AUTOSTART_OEMS.some((o) => m === o || m.includes(o));
};

/**
 * Which reliability problems exist right now? Order = display order.
 *  notifications : POST_NOTIFICATIONS denied / app notifications off → nothing can ring
 *  callChannel   : the incoming-calls channel was switched off by the user
 *  fullScreen    : Android 14+ full-screen-intent grant missing → locked phone shows a heads-up only
 *  battery       : not exempt from battery optimisation
 *  autostart     : known OEM and the user has not been pointed at Autostart yet
 * Unknown reads (undefined) never raise an issue.
 */
const computeReliabilityIssues = ({
  isAndroid, notificationsEnabled, callChannelEnabled, canFullScreen,
  batteryAllowed, manufacturer, autoStartAcked,
} = {}) => {
  if (!isAndroid) return [];
  const issues = [];
  if (notificationsEnabled === false) issues.push('notifications');
  else if (callChannelEnabled === false) issues.push('callChannel');
  if (canFullScreen === false) issues.push('fullScreen');
  if (batteryAllowed === false) issues.push('battery');
  if (isAutoStartOem(manufacturer) && !autoStartAcked) issues.push('autostart');
  return issues;
};

/** Offer the prompt? (snooze / perma-off still apply; hard failures ignore the 14-day snooze only on perma-off.) */
const shouldOffer = ({ issues, permaOff, snoozeUntil, now }) => {
  if (!Array.isArray(issues) || issues.length === 0) return false;
  if (permaOff) return false;
  const until = Number(snoozeUntil);
  if (Number.isFinite(until) && now < until) return false;
  return true;
};

module.exports = { AUTOSTART_OEMS, isAutoStartOem, computeReliabilityIssues, shouldOffer };
