// src/firebase/notifications.js
import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';

// Configure notifications for foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Request notification permission
export const requestNotificationPermission = async () => {
  try {
    // iOS & Android 13+ explicit permission
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await Notifications.requestPermissionsAsync();
      if (!granted.granted) return false;
    }

    const authStatus = await messaging().requestPermission();
    return (
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL
    );
  } catch (error) {
    console.error('Notification permission error:', error);
    return false;
  }
};

// Get FCM token
export const getFCMToken = async () => {
  const hasPermission = await requestNotificationPermission();
  if (!hasPermission) return null;

  try {
    if (!messaging().isDeviceRegisteredForRemoteMessages) {
      await messaging().registerDeviceForRemoteMessages();
    }

    const token = await messaging().getToken();
    console.log('FCM Token:', token);

    messaging().onTokenRefresh(newToken => {
      console.log('FCM Token refreshed:', newToken);
      // TODO: send newToken to your backend
    });

    return token;
  } catch (error) {
    console.error('Error getting FCM token:', error);
    return null;
  }
};

// Show local notification
export const showLocalNotification = async ({ title, body, data }) => {
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: null, // immediate
  });
};

// Initialize FCM listeners
export const initializeNotifications = () => {
  // Foreground message
  const unsubscribeOnMessage = messaging().onMessage(async remoteMessage => {
    console.log('Foreground message received:', remoteMessage);
    await showLocalNotification({
      title: remoteMessage.notification?.title || 'Notification',
      body: remoteMessage.notification?.body || '',
      data: remoteMessage.data,
    });
  });

  // Background message
  messaging().setBackgroundMessageHandler(async remoteMessage => {
    console.log('Background message received:', remoteMessage);
    return Promise.resolve();
  });

  // Opened from background
  const unsubscribeOnOpen = messaging().onNotificationOpenedApp(remoteMessage => {
    console.log('Notification opened from background:', remoteMessage);
  });

  // User interaction with notification (optional actions)
  const unsubscribeResponse = Notifications.addNotificationResponseReceivedListener(response => {
    console.log('Notification tapped:', response.notification.request.content.data);
  });

  return () => {
    unsubscribeOnMessage();
    unsubscribeOnOpen();
    unsubscribeResponse.remove();
  };
};