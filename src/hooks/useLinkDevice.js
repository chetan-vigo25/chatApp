import { useState, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useDeviceInfo } from '../contexts/DeviceInfoContext';
import { apiCall } from '../Config/Https';
import AsyncStorage from '@react-native-async-storage/async-storage';
import CryptoJS from 'crypto-js';
import { SALT_SECRET } from '@env';

const LINKED_DEVICES_KEY = 'linked_web_devices';

export default function useLinkDevice() {
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState(null);
  const [linkSuccess, setLinkSuccess] = useState(false);
  const [linkedDevice, setLinkedDevice] = useState(null);
  const { user } = useAuth();
  const deviceInfo = useDeviceInfo();

  const signPayload = (payload) => {
    const message = JSON.stringify(payload);
    return CryptoJS.HmacSHA256(message, SALT_SECRET || 'default-salt').toString();
  };

  const linkDevice = useCallback(
    async (qrData) => {
      console.log("qrData for the link devcei ---- ", user)
      if (!user?._id) {
        setLinkError('You must be logged in to link a device');
        return false;
      }

      if (!qrData?.sessionId) {
        setLinkError('Invalid QR data');
        return false;
      }

      setIsLinking(true);
      setLinkError(null);
      setLinkSuccess(false);

      const body = {
        sessionId: qrData.sessionId,
        userId: user._id,
        deviceInfo: {
          deviceName: deviceInfo?.modelName || deviceInfo?.brand || 'Unknown Device',
          platform: deviceInfo?.osName || 'unknown',
        },
      };

      const signature = signPayload(body);

      try {
        const response = await apiCall('POST', 'link-device', body, {
          headers: { 'X-Signature': signature },
        });

        // Save linked device locally
        const deviceRecord = {
          sessionId: qrData.sessionId,
          linkedAt: new Date().toISOString(),
          deviceName: body.deviceInfo.deviceName,
          platform: body.deviceInfo.platform,
        };

        await saveLinkedDevice(deviceRecord);
        setLinkedDevice(deviceRecord);
        setLinkSuccess(true);
        return true;
      } catch (error) {
        const status = error?.response?.status || error?.status;
        let message;

        if (status === 410 || error?.code === 'SESSION_EXPIRED') {
          message = 'QR code has expired. Please scan a new one.';
        } else if (status === 404) {
          message = 'Session not found. Please try again.';
        } else if (!status) {
          message = 'Network error. Please check your connection.';
        } else {
          message = error?.message || 'Failed to link device. Please try again.';
        }

        setLinkError(message);
        return false;
      } finally {
        setIsLinking(false);
      }
    },
    [user, deviceInfo]
  );

  const reset = useCallback(() => {
    setIsLinking(false);
    setLinkError(null);
    setLinkSuccess(false);
    setLinkedDevice(null);
  }, []);

  return {
    linkDevice,
    isLinking,
    linkError,
    linkSuccess,
    linkedDevice,
    reset,
  };
}

async function saveLinkedDevice(device) {
  try {
    const existing = await AsyncStorage.getItem(LINKED_DEVICES_KEY);
    const devices = existing ? JSON.parse(existing) : [];
    devices.push(device);
    await AsyncStorage.setItem(LINKED_DEVICES_KEY, JSON.stringify(devices));
  } catch (e) {
    console.error('Failed to save linked device:', e);
  }
}