import React, { createContext, useState, useContext } from 'react';
import * as Location from 'expo-location';

// Create a context
const DeviceLocationContext = createContext();

// Create a provider component
export const DeviceLocationProvider = ({ children }) => {
  const [location, setLocation] = useState(null);
  const [address, setAddress] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  // Function to request location permission and fetch the location
  const requestLocationPermission = async () => {
    try {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permission to access location was denied');
        return;
      }
      
      // Fetch the current location
      let location = await Location.getCurrentPositionAsync({});
      setLocation(location);
      
      // Fetch the address from reverse geocoding
      let address = await Location.reverseGeocodeAsync({
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      });
      setAddress(address);
    } catch (error) {
      setErrorMsg('Error fetching location');
    }
  };

  // Provide the current location and the requestLocationPermission function to the context
  return (
    <DeviceLocationContext.Provider value={{ location, address, errorMsg, requestLocationPermission }}>
      {children}
    </DeviceLocationContext.Provider>
  );
};

// Hook to use the device location context
export const useDeviceLocation = () => {
  const context = useContext(DeviceLocationContext);
  
  // If provider is not mounted, return safe defaults to avoid crashes
  if (context === undefined) {
    return { location: null, address: null, errorMsg: 'DeviceLocationProvider not mounted' };
  }
  return context;
};
