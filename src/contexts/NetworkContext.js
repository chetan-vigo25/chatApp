import React, { createContext, useState, useEffect, useContext, useRef } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { Alert } from 'react-native';

export const NetworkContext = createContext();

export const NetworkProvider = ({ children }) => {
  const [isConnected, setIsConnected] = useState(true);
  const [isInternetReachable, setIsInternetReachable] = useState(true);
  const [networkType, setNetworkType] = useState('unknown');
  const previousConnectedRef = useRef(true);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      const currentlyConnected = Boolean(state.isConnected);
      const internetReachable = state.isInternetReachable == null ? currentlyConnected : Boolean(state.isInternetReachable);

      setIsConnected(currentlyConnected);
      setIsInternetReachable(internetReachable);
      setNetworkType(state.type || 'unknown');

      if (!currentlyConnected && previousConnectedRef.current) {
        Alert.alert('No Internet', 'You have lost connection.');
      }

      if (currentlyConnected && !previousConnectedRef.current) {
        Alert.alert('Connected', 'Internet connection restored.');
      }

      previousConnectedRef.current = currentlyConnected;
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