import React, { createContext, useState, useContext, useEffect } from 'react';
import * as Location from 'expo-location';
import { setLastKnownLocation } from '../utils/lastKnownLocation';
import { ensurePermission, PERMISSION_IDS } from '../features/permissions/ensurePermission';

// Create a context
const DeviceLocationContext = createContext();

// Module-level setters registered by the mounted provider, so the imperative
// fetch below (callable from NON-React code — e.g. the call signaling service)
// can still push its result into the context for any screen that reads it.
let _setLocation = null;
let _setAddress = null;
let _setErrorMsg = null;

/**
 * Imperative device-location fetch — the same permission → current-position →
 * reverse-geocode flow the provider always did, but callable from anywhere
 * (screens, services, the call path). Returns `{ latitude, longitude, accuracy }`
 * or null (permission denied / location services off / fetch failed).
 *
 * The heavy reverse-geocode runs in the background AFTER the coordinates are
 * returned, so a caller waiting on this (e.g. `call:ring`) is never held up
 * by the address lookup.
 */
export const fetchDeviceLocation = async () => {
  try {
    // Shared in-context gate: already granted → no dialog; denied earlier (startup
    // included) → the OS dialog is raised again here. `silent` because this runs on
    // background paths (login payload, call ring) where an alert would be intrusive
    // — the screens that ask for location explicitly own the messaging.
    const locationOk = await ensurePermission(PERMISSION_IDS.LOCATION, { silent: true });
    if (!locationOk) {
      _setErrorMsg?.('Permission to access location was denied');
      return null;
    }

    // Fetch the current location
    const location = await Location.getCurrentPositionAsync({});
    const { latitude, longitude, accuracy } = location?.coords || {};
    if (latitude == null || longitude == null) return null;

    _setLocation?.(location);
    // Feed the app-wide warm cache (used by the call payload as a fallback).
    setLastKnownLocation({ latitude, longitude, accuracy });

    // Reverse-geocode in the background — context consumers (login payload)
    // get the address when it lands; the caller isn't blocked on it.
    Location.reverseGeocodeAsync({ latitude, longitude })
      .then((address) => { _setAddress?.(address); })
      .catch(() => {});

    return { latitude, longitude, accuracy: accuracy != null ? Number(accuracy) : null };
  } catch (error) {
    _setErrorMsg?.('Error fetching location');
    return null;
  }
};

// Create a provider component
export const DeviceLocationProvider = ({ children }) => {
  const [location, setLocation] = useState(null);
  const [address, setAddress] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);

  // Expose this instance's setters to the imperative fetch above.
  useEffect(() => {
    _setLocation = setLocation;
    _setAddress = setAddress;
    _setErrorMsg = setErrorMsg;
    return () => {
      if (_setLocation === setLocation) { _setLocation = null; _setAddress = null; _setErrorMsg = null; }
    };
  }, []);

  // Function to request location permission and fetch the location (kept for
  // existing consumers — now just delegates to the shared imperative fetch).
  const requestLocationPermission = fetchDeviceLocation;

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
