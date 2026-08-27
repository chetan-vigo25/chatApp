import { useEffect, useState, useCallback } from 'react';
import {
  subscribeContactNames,
  loadContactNames,
  getContactNamesVersion,
  resolveDisplayName,
  resolvePushNameLabel,
  getSavedName,
  isSavedContact,
  formatPhoneNumber,
} from '../services/contactNameStore';

/**
 * useDisplayName
 * ──────────────
 * Subscribes the calling screen to the canonical contact-name store and hands
 * back the resolver bound to the CURRENT address book. Whenever contacts change
 * (sync finished, contact saved, contact deleted) the store bumps its version
 * and this hook re-renders — that is how a name flips from a number to the
 * saved name with no restart and no re-navigation.
 *
 *   const { resolveName, pushNameOf, namesVersion } = useDisplayName();
 *   const label = resolveName({ userId, phone, pushName: peer.fullName });
 *
 * `namesVersion` is exported so memoized lists can include it in their deps and
 * re-derive rows when the directory changes.
 */
export default function useDisplayName() {
  const [version, setVersion] = useState(getContactNamesVersion());

  useEffect(() => {
    loadContactNames();
    return subscribeContactNames((v) => setVersion(v));
  }, []);

  const resolveName = useCallback((args) => resolveDisplayName(args), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const pushNameOf = useCallback((args) => resolvePushNameLabel(args), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const savedNameOf = useCallback((args) => getSavedName(args), [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const isSaved = useCallback((args) => isSavedContact(args), [version]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    namesVersion: version,
    resolveName,
    pushNameOf,
    savedNameOf,
    isSaved,
    formatPhoneNumber,
  };
}
