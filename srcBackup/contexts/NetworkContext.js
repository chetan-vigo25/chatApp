import React, { createContext, useState, useEffect, useContext } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { Alert } from 'react-native';

export const NetworkContext = createContext();

export const NetworkProvider = ({ children }) => {
  const [isConnected, setIsConnected] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      if (!state.isConnected && isConnected) {
        Alert.alert('No Internet', 'You have lost connection.');
        setIsConnected(false);
      }

      if (state.isConnected && !isConnected) {
        Alert.alert('Connected', 'Internet connection restored.');
        setIsConnected(true);
        setRefreshKey(prev => prev + 1); // 🔁 Trigger refresh
      }
    });

    return () => unsubscribe();
  }, [isConnected]);

  return (
    <NetworkContext.Provider value={{ isConnected }}>
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