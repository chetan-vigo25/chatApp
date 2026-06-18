import React, { createContext, useState, useEffect, useContext } from 'react';
import NetInfo from '@react-native-community/netinfo';

export const NetworkContext = createContext();

export const NetworkProvider = ({ children }) => {
  const [isConnected, setIsConnected] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState(true);
  const [networkType, setNetworkType] = useState('unknown');

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const currentlyConnected = Boolean(state.isConnected);
      const internetReachable = state.isInternetReachable == null ? currentlyConnected : Boolean(state.isInternetReachable);

      setIsConnected(currentlyConnected);
      setIsInternetReachable(internetReachable);
      setNetworkType(state.type || 'unknown');

      // Connectivity transitions are handled silently — no blocking "No
      // Internet" / "Connected" dialogs. Losing/regaining the network (screen
      // off, Wi-Fi/data toggle) is routine; the socket layer reconnects on its
      // own and any UI can subscribe to `isConnected` for a subtle inline
      // banner instead of interrupting the user with an alert.
    });

    return () => unsubscribe();
  }, []);

  return (
    <NetworkContext.Provider value={{ isConnected, isInternetReachable, networkType }}>
      {children}
    </NetworkContext.Provider>
  );
};

export const useNetwork = () => {
  const context = useContext(NetworkContext);
  if (!context) {
    throw new Error('useNetwork must be used within a NetworkProvider');
  }
  return context;
};