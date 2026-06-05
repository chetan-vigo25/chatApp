import { useContext } from 'react';
import { CallContext } from './CallProvider';

// Convenience hook — read call state + actions from anywhere in the app.
export const useCall = () => useContext(CallContext) || {};

export default useCall;
