// Fallback for servers that do not send `isBusinessSender` on chat rows yet
// (e.g. a staging backend that has not been redeployed). Asks the profile
// endpoint (user/auth/view) once per peer per session and decides with
// looksLikeBusinessSender. Once the new backend is live the flag arrives on
// the row and this is only a harmless extra request.
import * as profileServices from '../Redux/Services/Profile/Profile.Services';
import { looksLikeBusinessSender, addProbedBusinessPeer } from './businessChat';
import { kv } from '../services/kvStorage';

// Answers are also kept on the device (per-account MMKV, wiped on logout): with
// only the in-memory map, every app start forgot them, so the first open of a
// business chat rendered as an ordinary chat (call buttons, plain media
// bubbles) and flipped to the business layout when the probe came back — the
// "flicker" on opening Juber Fashion Store after a reload.
const STORE_KEY = 'business_peer_probe_v1';
const results = new Map(); // peerId → boolean
const inflight = new Map(); // peerId → Promise<boolean>
let hydrated = false;
const checkedThisSession = new Set();
const hydrate = () => {
  if (hydrated) return;
  try {
    const raw = kv.getStringSync(STORE_KEY);
    if (raw === undefined && !kv.isAvailable()) return; // store not ready yet — retry later
    hydrated = true;
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && typeof saved === 'object') {
      Object.keys(saved).forEach((id) => {
        const isBiz = saved[id] === true;
        results.set(id, isBiz);
        if (isBiz) addProbedBusinessPeer(id);
      });
    }
  } catch { hydrated = true; }
};
const persist = () => {
  try {
    const out = {};
    results.forEach((v, k) => { out[k] = v === true; });
    kv.setItem(STORE_KEY, JSON.stringify(out)).catch(() => {});
  } catch { /* best-effort */ }
};

export { looksLikeBusinessSender };

// Synchronous answer if this session already probed the peer (else undefined).
export const knownBusinessPeer = (peerId) => {
  if (peerId == null) return undefined;
  hydrate();
  return results.get(String(peerId));
};

export const probeBusinessPeer = (peerId) => {
  if (peerId == null || peerId === '') return Promise.resolve(false);
  const id = String(peerId);
  hydrate();
  // A stored answer paints immediately; the server is still asked once per
  // session (below) so a peer that stops/starts being a business is picked up.
  if (results.has(id) && checkedThisSession.has(id)) return Promise.resolve(results.get(id));
  if (inflight.has(id)) return inflight.get(id);
  const p = profileServices.profileDetails(id)
    .then((res) => {
      const isBiz = looksLikeBusinessSender(res?.data || null);
      results.set(id, isBiz);
      checkedThisSession.add(id);
      if (isBiz) addProbedBusinessPeer(id);
      persist();
      return isBiz;
    })
    // A failed probe is not an answer — keep any stored one, retry later.
    .catch(() => (results.has(id) ? results.get(id) : false))
    .finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
};
