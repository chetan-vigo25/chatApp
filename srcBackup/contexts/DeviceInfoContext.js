import React, { createContext, useState, useEffect } from 'react';
import * as Device from 'expo-device';
import Constants from 'expo-constants';


export const DeviceInfoContext = createContext();

export const DeviceInfoProvider = ({ children }) => {
  const [deviceInfo, setDeviceInfo] = useState(null);

  const getDeviceType = () => {
    switch (Device.deviceType) {
      case Device.DeviceType.PHONE:
        return 'mobile';
      case Device.DeviceType.TABLET:
        return 'tablet';
      case Device.DeviceType.DESKTOP:
        return 'desktop';
      case Device.DeviceType.TV:
        return 'tv';
      default:
        return 'unknown';
    }
  };

  useEffect(() => {
    const fetchDeviceInfo = async () => {
      try {
        const totalMemoryInGB = (Device.totalMemory / Math.pow(1024, 3)).toFixed(2);
         const info = {
           modelName: Device.modelName,
           brand: Device.brand,
           osName: Device.osName,
           memory: totalMemoryInGB,
           version: Device.osVersion,
           deviceYearClass: Device.deviceYearClass,
           deviceType: getDeviceType(),
           appVersion: Constants.expoConfig?.version,
         };
        setDeviceInfo(info);
      } catch (error) {
        console.error('Error fetching device info:', error);
      }
    };
    fetchDeviceInfo();
  }, []);

  return (
    <DeviceInfoContext.Provider value={deviceInfo}>
      {children}
    </DeviceInfoContext.Provider>
  );
};

export const useDeviceInfo = () => {
  const context = React.useContext(DeviceInfoContext);
  if (!context) {
    throw new Error('useDeviceInfo must be used within a DeviceInfoProvider');
  }
  return context;
};