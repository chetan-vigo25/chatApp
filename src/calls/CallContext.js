import { createContext } from 'react';

// Standalone context module. Lives apart from CallProvider so that `useCall`
// can read the context WITHOUT importing CallProvider — that import was the head
// of the call-module require cycle:
//   useCall → CallProvider → CallOverlay / IncomingCallBanner → useCall
// CallProvider and useCall now both import this leaf, breaking the cycle.
export const CallContext = createContext(null);

export default CallContext;
