/**
 * Call-failure black box.
 *
 * A call that dies on "Connecting…" leaves no trace we can read afterwards: the
 * device log buffer is small (256 KB on many phones) and rotates within minutes,
 * and almost every call log line is __DEV__-only. So the one moment that matters
 * — why an answered call never connected — was unrecoverable (2026-09-23: an
 * Android callee woken from an 11-minute freeze answered, sat on "Connecting…"
 * for 24s and the call was cut; nothing survived to say why).
 *
 * This keeps a small in-memory trace of call events (release builds included)
 * and, when a call FAILS, writes one self-contained JSON report — trace + call
 * state + the engine's own view of its media-server connection — to a file in
 * the app's document directory. Reports survive restarts and log rotation.
 *
 * Read them back:
 *   Android (debug build): adb shell run-as com.chat.baatCheet cat files/call-diagnostics.log
 *   Metro/CDP:             readCallFailures()
 *
 * Diagnostics only: nothing here changes call behaviour, and every entry point
 * swallows its own errors so it can never break a call.
 */
import { AppState, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';

const TRACE_MAX = 250;          // recent call events kept in memory
const REPORTS_MAX = 20;         // reports kept on disk (oldest dropped)
const FILE_NAME = 'call-diagnostics.log';

const trace = [];
let writeChain = Promise.resolve();

const filePath = () => (FileSystem.documentDirectory ? `${FileSystem.documentDirectory}${FILE_NAME}` : null);

// JSON-safe, size-bounded copy of an arbitrary payload.
const compact = (v, max = 600) => {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? `${s.slice(0, max)}…` : JSON.parse(s);
  } catch (_) {
    return String(v).slice(0, max);
  }
};

/** Record one call event in the in-memory trace. Cheap; safe to call anywhere. */
export const markCallEvent = (tag, data) => {
  try {
    trace.push({ t: Date.now(), tag: String(tag), ...(data !== undefined ? { d: compact(data) } : {}) });
    if (trace.length > TRACE_MAX) trace.splice(0, trace.length - TRACE_MAX);
  } catch (_) { /* never throw from diagnostics */ }
};

AppState.addEventListener('change', (next) => markCallEvent('appstate', next));

const readReports = async () => {
  const path = filePath();
  if (!path) return [];
  try {
    const info = await FileSystem.getInfoAsync(path);
    if (!info.exists) return [];
    const raw = await FileSystem.readAsStringAsync(path);
    return raw.split('\n').filter(Boolean);
  } catch (_) {
    return [];
  }
};

/**
 * Write a failure report. `context` is the call snapshot at the moment of
 * failure; `engine` is the engine's own diagnostic snapshot (if available).
 */
export const recordCallFailure = (reason, { context, engine } = {}) => {
  const report = {
    at: new Date().toISOString(),
    reason: String(reason),
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    appState: AppState.currentState,
    context: compact(context, 4000),
    engine: compact(engine, 4000),
    trace: trace.map((e) => ({ ...e, ago: Date.now() - e.t })),
  };
  // One line for logcat/Console even in release builds — the file holds the rest.
  try {
    console.warn('[CALL][DIAG] call failed — report saved', {
      reason: report.reason,
      callId: context?.signalId || context?.callId || null,
      engineRegistered: engine?.sdk?.registered,
      socketConnected: engine?.sdk?.socketConnected,
      lastInboundAgoMs: engine?.sdk?.lastInboundAgoMs,
    });
  } catch (_) { /* */ }
  const path = filePath();
  if (!path) return Promise.resolve(false);
  // Serialise writes so two failures in a row can't interleave.
  writeChain = writeChain.then(async () => {
    try {
      const lines = await readReports();
      lines.push(JSON.stringify(report));
      const kept = lines.slice(-REPORTS_MAX);
      await FileSystem.writeAsStringAsync(path, `${kept.join('\n')}\n`);
      return true;
    } catch (_) {
      return false;
    }
  });
  return writeChain;
};

/** All saved reports, newest last (parsed). */
export const readCallFailures = async () => {
  const lines = await readReports();
  return lines.map((l) => { try { return JSON.parse(l); } catch (_) { return { raw: l }; } });
};

/** Delete saved reports (e.g. after they have been collected). */
export const clearCallFailures = async () => {
  const path = filePath();
  if (!path) return;
  try { await FileSystem.deleteAsync(path, { idempotent: true }); } catch (_) { /* */ }
};

export default { markCallEvent, recordCallFailure, readCallFailures, clearCallFailures };
