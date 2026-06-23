import { useContext } from 'react';
import { CallContext } from './CallContext';

// Convenience hook — read call state + actions from anywhere in the app.
export const useCall = () => useContext(CallContext) || {};

export default useCall;
