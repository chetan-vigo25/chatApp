import { Platform, PermissionsAndroid } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';

// Configure foreground notifications
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

 export const setupNotificationCategory = async () => {
   await Notifications.setNotificationCategoryAsync('chat-message', [
     {
       identifier: 'reply',
       buttonTitle: 'Reply',
       options: {
         opensAppToForeground: false,
       },
       textInput: {
         submitButtonTitle: 'Send',
         placeholder: 'Type your reply...',
       },
     },
   ]);
 };

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
    return false;
  }
};

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

// --------------------------------------------------
// Optimized Local Notification Logic
// --------------------------------------------------
const showLocalNotification = async (remoteMessage) => {
  const { notification, data } = remoteMessage;
  const title = notification?.title || data?.title || 'Notification';
  const body = notification?.body || data?.body || '';
  await Notifications.scheduleNotificationAsync({
    content: { title, body, data, 
      // categoryIdentifier: 'chat-message', 
    },
    trigger: null, 
  });
};

export const initializeNotifications = () => {
  const unsubscribeOnMessage = messaging().onMessage(async remoteMessage => {
    console.log('Foreground Message received');
    await showLocalNotification(remoteMessage);
  });
  messaging().setBackgroundMessageHandler(async remoteMessage => {
    console.log('Background Message handled');
    // We just return a promise. The OS handles the display automatically.
    return Promise.resolve();
  });
  const unsubscribeOnOpen = messaging().onNotificationOpenedApp(remoteMessage => {
    console.log('Notification opened from background:', remoteMessage);
  });

  Notifications.addNotificationResponseReceivedListener(response => {
    if (response.actionIdentifier === 'reply') {
      console.log('Reply button tapped!', response.notification.request.content.data);
      // TODO: implement comment/reply functionality later
    }
  });

  return () => {
    unsubscribeOnMessage();
    unsubscribeOnOpen();
  };
};
