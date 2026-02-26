import firebase from '@react-native-firebase/app';
import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';
import { Platform, PermissionsAndroid } from 'react-native';

// Ensure Firebase App exists
if (!firebase.apps.length) {
  firebase.initializeApp();
}

// Configure foreground notifications
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Setup iOS notification categories (for reply buttons, etc.)
export const setupNotificationCategory = async () => {
  if (Platform.OS === 'ios') {
    await Notifications.setNotificationCategoryAsync('chat-message', [
      {
        identifier: 'reply',
        buttonTitle: 'Reply',
        options: { opensAppToForeground: true },
        textInput: {
          submitButtonTitle: 'Send',
          placeholder: 'Type your reply...',
        },
      },
    ]);
  }
};

// Request permission for notifications
export const requestNotificationPermission = async () => {
  try {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return false;
    }

    const authStatus = await messaging().requestPermission();
    return (
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL
    );
  } catch (error) {
    console.error('Permission request error:', error);
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
      // Send token to your backend if needed
    });

    return token;
  } catch (error) {
    console.error('Error getting FCM token:', error);
    return null;
  }
};

// Show a local notification from a remote message
const showLocalNotification = async (remoteMessage) => {
  if (!remoteMessage) return;

  const { notification, data } = remoteMessage;
  const title = notification?.title || data?.title || 'Notification';
  const body = notification?.body || data?.body || '';

  await Notifications.scheduleNotificationAsync({
    content: { title, body, data },
    trigger: null, // immediately
  });
};

// Initialize notification listeners
export const initializeNotifications = () => {
  // Foreground messages
  const unsubscribeOnMessage = messaging().onMessage(async remoteMessage => {
    console.log('Foreground message received:', remoteMessage);
    await showLocalNotification(remoteMessage);
  });

  // Background messages
  messaging().setBackgroundMessageHandler(async remoteMessage => {
    console.log('Background message handled:', remoteMessage);
    return Promise.resolve();
  });

  // App opened from notification
  const unsubscribeOnOpen = messaging().onNotificationOpenedApp(remoteMessage => {
    console.log('Notification opened from background:', remoteMessage);
  });

  // iOS action buttons (like Reply)
  const responseListener = Notifications.addNotificationResponseReceivedListener(
    response => {
      if (response.actionIdentifier === 'reply') {
        console.log('Reply tapped!', response.notification.request.content.data);
        // Handle reply action
      }
    }
  );

  return () => {
    unsubscribeOnMessage();
    unsubscribeOnOpen();
    responseListener.remove();
  };
};