/**
 * Hook that manages the full device-linking lifecycle:
 * - Linking a new device (crypto + REST API call)
 * - Listening to socket events for link success/error
 * - Fetching the list of linked devices
 * - Unlinking a device
 *
 * API contracts:
 *  POST /link    → { device, webToken, userId, sessionId }
 *  GET  /devices → { devices: [...], count }
 *  POST /unlink  → { deviceId }
 *
 * Socket events listened:
 *  device:link:success → { sessionId, deviceId, message }
 *  socket:error        → { event, message }
 */
import { useState, useCallback, useEffect, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateKeyPair, signData, storeKeyPair } from '../utils/deviceCrypto';
import { getDeviceInfo } from '../utils/getDeviceInfo';
import * as api from '../services/deviceLinkApi';
import { ERROR_MESSAGES, SOCKET_EVENTS } from '../constants';
import { getSocket } from '../../../Redux/Services/Socket/socket';

const TAG = '[DeviceLink]';

export default function useDeviceLinking() {
  const [isLinking, setIsLinking] = useState(false);
  const [linkedDevices, setLinkedDevices] = useState([]);
  const [isFetching, setIsFetching] = useState(false);
  const [error, setError] = useState(null);
  const [socketLinkResult, setSocketLinkResult] = useState(null);
  const socketListenersAttached = useRef(false);

  // ------------------------------------------------------------------
  // Socket event listeners for device-link related events
  // ------------------------------------------------------------------
  useEffect(() => {
    let socket = null;
    try {
      socket = getSocket();
    } catch (e) {
      console.log(`${TAG} getSocket() failed:`, e?.message);
    }

    if (!socket || socketListenersAttached.current) return;
    socketListenersAttached.current = true;

    console.log(`${TAG} Attaching socket listeners, socketId:`, socket.id);

    const onLinkSuccess = (data) => {
      console.log(`${TAG} <<<< device:link:success >>>>`, JSON.stringify(data, null, 2));
      setSocketLinkResult(data);
    };

    const onSocketError = (data) => {
      console.log(`${TAG} <<<< socket:error >>>>`, JSON.stringify(data, null, 2));
      if (data?.event?.includes('device:link') || data?.event?.includes('link')) {
        setError(data?.message || 'Socket error during device linking');
      }
    };

    const onDeviceLinkRequest = (data) => {
      console.log(`${TAG} <<<< device:link:request (echo) >>>>`, JSON.stringify(data, null, 2));
    };

    socket.on(SOCKET_EVENTS.LINK_SUCCESS, onLinkSuccess);
    socket.on(SOCKET_EVENTS.SOCKET_ERROR, onSocketError);
    socket.on(SOCKET_EVENTS.LINK_REQUEST, onDeviceLinkRequest);

    // Debug catch-all — only if socket.onAny exists (socket.io-client v4+)
    let debugOnAny = null;
    if (typeof socket.onAny === 'function') {
      debugOnAny = (eventName, ...args) => {
        if (eventName.startsWith('device:') || eventName === 'socket:error') {
          console.log(`${TAG} [onAny] "${eventName}"`, JSON.stringify(args, null, 2));
        }
      };
      socket.onAny(debugOnAny);
    }

    return () => {
      console.log(`${TAG} Detaching socket listeners`);
      if (socket) {
        socket.off(SOCKET_EVENTS.LINK_SUCCESS, onLinkSuccess);
        socket.off(SOCKET_EVENTS.SOCKET_ERROR, onSocketError);
        socket.off(SOCKET_EVENTS.LINK_REQUEST, onDeviceLinkRequest);
        if (debugOnAny && typeof socket.offAny === 'function') {
          socket.offAny(debugOnAny);
        }
      }
      socketListenersAttached.current = false;
    };
  }, []);

  // ------------------------------------------------------------------
  // Link a device via REST (primary) with full debug logging
  // ------------------------------------------------------------------
  const linkDevice = useCallback(async (sessionId, qrPublicKey) => {
    setIsLinking(true);
    setError(null);
    setSocketLinkResult(null);

    console.log(`${TAG} ---- LINK FLOW START ----`);
    console.log(`${TAG} sessionId:`, sessionId);
    console.log(`${TAG} qrPublicKey (first 80 chars):`, qrPublicKey?.substring(0, 80));

    try {
      // 1. Generate mobile key pair for signing
      const keyPair = generateKeyPair();
      console.log(`${TAG} Generated keyPair, publicKey (first 60):`, keyPair.publicKey?.substring(0, 60));

      // 2. Sign the sessionId with the mobile's private key
      const signature = signData(sessionId, keyPair.privateKey);
      console.log(`${TAG} Signature (first 40):`, signature?.substring(0, 40));

      // 3. Build device info using the PUBLIC KEY FROM THE QR CODE
      const deviceInfo = getDeviceInfo(qrPublicKey);
      console.log(`${TAG} deviceInfo payload:`, JSON.stringify({
        deviceName: deviceInfo.deviceName,
        deviceType: deviceInfo.deviceType,
        platform: deviceInfo.platform,
        browser: deviceInfo.browser,
        os: deviceInfo.os,
        publicKey: deviceInfo.publicKey?.substring(0, 60) + '...',
      }, null, 2));

      // 4. Full payload being sent
      const payload = { sessionId, deviceInfo, signature };
      console.log(`${TAG} POST /link full payload:`, JSON.stringify({
        sessionId: payload.sessionId,
        deviceInfo: { ...payload.deviceInfo, publicKey: payload.deviceInfo.publicKey?.substring(0, 60) + '...' },
        signature: payload.signature?.substring(0, 40) + '...',
      }, null, 2));

      // 5. Call POST /link
      const result = await api.linkDevice(payload);
      console.log(`${TAG} POST /link response:`, JSON.stringify(result, null, 2));

      // 6. Persist mobile key pair for future verification
      await storeKeyPair(keyPair);
      console.log(`${TAG} KeyPair stored securely`);

      // 7. Extract response data
      const userData = result?.data || {};
      const tokenData = result?.token || {};
      const socketMeta = result?._socketMeta || {};

      // 8. Store web session tokens if provided (for future reference)
      if (tokenData.accessToken) {
        await AsyncStorage.setItem('webLinkedToken', tokenData.accessToken);
      }

      console.log(`${TAG} ---- LINK FLOW SUCCESS ----`);
      console.log(`${TAG} User: ${userData.fullName}, DeviceId: ${userData.deviceId}`);
      console.log(`${TAG} SessionId: ${socketMeta.sessionId}, LinkedAt: ${socketMeta.linkedAt}`);

      return {
        user: userData,
        token: tokenData,
        sessionId: socketMeta.sessionId || socketMeta.qrSessionId || sessionId,
        linkedAt: socketMeta.linkedAt,
        deviceId: userData.deviceId,
        deviceName: deviceInfo.deviceName,
        platform: deviceInfo.os,
      };
    } catch (err) {
      console.log(`${TAG} ---- LINK FLOW ERROR ----`);
      console.log(`${TAG} Error object:`, err);
      console.log(`${TAG} err.message:`, err?.message);
      console.log(`${TAG} err.response?.status:`, err?.response?.status);
      console.log(`${TAG} err.response?.data:`, JSON.stringify(err?.response?.data, null, 2));
      console.log(`${TAG} err.code:`, err?.code);

      const code = err?.code || err?.response?.data?.code || err?.response?.code;
      const message = ERROR_MESSAGES[code]
        || err?.message
        || 'Failed to link device. Please try again.';
      setError(message);
      return false;
    } finally {
      setIsLinking(false);
    }
  }, []);

  // ------------------------------------------------------------------
  // Fetch linked devices
  // ------------------------------------------------------------------
  const fetchDevices = useCallback(async () => {
    setIsFetching(true);
    setError(null);
    console.log(`${TAG} GET /devices...`);
    try {
      const response = await api.getLinkedDevices();
      console.log(`${TAG} GET /devices response:`, JSON.stringify(response, null, 2));

      let list = [];
      if (Array.isArray(response)) {
        list = response;
      } else if (Array.isArray(response?.devices)) {
        list = response.devices;
      } else if (Array.isArray(response?.data)) {
        list = response.data;
      }

      console.log(`${TAG} Parsed ${list.length} devices`);
      setLinkedDevices(list);
      return list;
    } catch (err) {
      console.log(`${TAG} GET /devices error:`, err);
      setError(err?.message || 'Failed to fetch linked devices.');
      return [];
    } finally {
      setIsFetching(false);
    }
  }, []);

  // ------------------------------------------------------------------
  // Unlink a device
  // ------------------------------------------------------------------
  const unlinkDevice = useCallback(async (deviceId) => {
    setError(null);
    console.log(`${TAG} POST /unlink deviceId:`, deviceId);
    try {
      const result = await api.unlinkDevice(deviceId);
      console.log(`${TAG} POST /unlink response:`, JSON.stringify(result, null, 2));
      setLinkedDevices((prev) => prev.filter(
        (d) => (d.deviceId || d._id) !== deviceId
      ));
      return true;
    } catch (err) {
      console.log(`${TAG} POST /unlink error:`, err);
      const code = err?.code || err?.response?.data?.code;
      const message = ERROR_MESSAGES[code]
        || err?.message
        || 'Failed to unlink device.';
      setError(message);
      return false;
    }
  }, []);

  /** Clear the error state */
  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    linkDevice,
    isLinking,
    linkedDevices,
    fetchDevices,
    isLoading: isFetching,
    isFetching,
    unlinkDevice,
    error,
    clearError,
    socketLinkResult,
  };
}