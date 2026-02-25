// src/firebase/fcmService.js
import { Platform, PermissionsAndroid, Alert } from 'react-native';
import messaging from '@react-native-firebase/messaging';
import * as Notifications from 'expo-notifications';

// --------------------------------------------------
// 🔔 Configure foreground notifications
// --------------------------------------------------
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// --------------------------------------------------
// 🏷️ Create "Comment" category
// --------------------------------------------------
export const setupNotificationCategory = async () => {
  await Notifications.setNotificationCategoryAsync('comment-message', [
    {
      identifier: 'comment',
      buttonTitle: 'Comment',
      options: { opensAppToForeground: true }, // Opens app on tap
    },
  ]);
};

// --------------------------------------------------
// 🔐 Request Notification Permission
// --------------------------------------------------
export const requestNotificationPermission = async () => {
  try {
    if (Platform.OS === 'android' && Platform.Version >= 33) {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        console.log('Notification permission denied on Android 13+');
        return false;
      }
    }

    const authStatus = await messaging().requestPermission();
    const enabled =
      authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
      authStatus === messaging.AuthorizationStatus.PROVISIONAL;

    if (enabled) {
      console.log('Notification permission granted:', authStatus);
      return true;
    } else {
      console.log('User denied notifications');
      return false;
    }
  } catch (error) {
    console.error('Error requesting notification permission:', error);
    return false;
  }
};

// --------------------------------------------------
// 📲 Get FCM Token
// --------------------------------------------------
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
// 🔔 Show Local Notification
// --------------------------------------------------
const showLocalNotification = async (remoteMessage) => {
  const { notification, data } = remoteMessage;
  const title = notification?.title || data?.title || 'Notification';
  const body = notification?.body || data?.body || '';

  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      // categoryIdentifier: 'comment-message', // Adds Comment button
      data: remoteMessage.data,
    },
    trigger: null, // Show immediately
  });
};

// --------------------------------------------------
// 🟢 Initialize Notification Listeners
// --------------------------------------------------
export const initializeNotifications = () => {
  let lastMessageId = null;

  // -----------------------------
  // Foreground Messages
  // -----------------------------
  const unsubscribeOnMessage = messaging().onMessage(async remoteMessage => {
    const { notification, data, messageId } = remoteMessage;

    // Prevent duplicates
    if (messageId && messageId === lastMessageId) return;
    lastMessageId = messageId;

    const title = notification?.title || data?.title || 'Notification';
    const body = notification?.body || data?.body || '';

    // Optional: show alert in app
    // Alert.alert(title, body);

    // Show local notification
    await showLocalNotification(remoteMessage);
  });

  // -----------------------------
  // Background & Killed Messages
  // -----------------------------
  messaging().setBackgroundMessageHandler(async remoteMessage => {
    const { notification, data, messageId } = remoteMessage;

    if (messageId && messageId === lastMessageId) return;
    lastMessageId = messageId;

    await showLocalNotification(remoteMessage);
  });

  // -----------------------------
  // Notification Tap Handler
  // -----------------------------
  const unsubscribeOnOpen = messaging().onNotificationOpenedApp(remoteMessage => {
    const { notification, data } = remoteMessage;
    console.log('Notification opened from background:', notification || data);
    // TODO: navigate user to screen, e.g.,
    // navigation.navigate('CommentScreen', { postId: data?.postId });
  });

  // Handle app opened from quit state
  messaging()
    .getInitialNotification()
    .then(remoteMessage => {
      if (remoteMessage) {
        const { notification, data } = remoteMessage;
        console.log('App opened from quit state:', notification || data);
      }
    });

  // -----------------------------
  // Comment Button Tap Handler
  // -----------------------------
  Notifications.addNotificationResponseReceivedListener(response => {
    if (response.actionIdentifier === 'comment') {
      console.log('Comment button pressed', response.notification.request.content.data);
      // TODO: navigate to comment screen
      // e.g., navigation.navigate('CommentScreen', { postId: response.notification.request.content.data?.postId })
    }
  });

  return () => {
    unsubscribeOnMessage();
    unsubscribeOnOpen();
  };
};



/////////////////////////////////////////

// src/firebase/fcmService.js

// import { Platform, PermissionsAndroid } from 'react-native';
// import messaging from '@react-native-firebase/messaging';
// import * as Notifications from 'expo-notifications';

// // --------------------------------------------------
// // 🔔 Configure how notifications behave when app is foreground
// // --------------------------------------------------
// Notifications.setNotificationHandler({
//   handleNotification: async () => ({
//     shouldShowAlert: true,
//     shouldPlaySound: true,
//     shouldSetBadge: false,
//   }),
// });

// // --------------------------------------------------
// // 📨 Create Reply Category (Call once when app starts)
// // --------------------------------------------------
// // export const setupNotificationCategory = async () => {
// //   await Notifications.setNotificationCategoryAsync('chat-message', [
// //     {
// //       identifier: 'reply',
// //       buttonTitle: 'Reply',
// //       options: {
// //         opensAppToForeground: false,
// //       },
// //       textInput: {
// //         submitButtonTitle: 'Send',
// //         placeholder: 'Type your reply...',
// //       },
// //     },
// //   ]);
// // };

// export const setupNotificationCategory = async () => {
//   await Notifications.setNotificationCategoryAsync('comment-message', [
//     {
//       identifier: 'comment',
//       buttonTitle: 'Comment',
//       options: {
//         opensAppToForeground: true, // 👈 Opens app
//       },
//     },
//   ]);
// };

// // --------------------------------------------------
// // 🔐 Request Notification Permission
// // --------------------------------------------------
// export const requestNotificationPermission = async () => {
//   try {
//     if (Platform.OS === 'android' && Platform.Version >= 33) {
//       const granted = await PermissionsAndroid.request(
//         PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
//       );

//       if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
//         console.log('Notification permission denied on Android 13+');
//         return false;
//       }
//     }

//     const authStatus = await messaging().requestPermission();
//     const enabled =
//       authStatus === messaging.AuthorizationStatus.AUTHORIZED ||
//       authStatus === messaging.AuthorizationStatus.PROVISIONAL;

//     return enabled;
//   } catch (error) {
//     console.error('Permission error:', error);
//     return false;
//   }
// };

// // --------------------------------------------------
// // 📲 Get FCM Token
// // --------------------------------------------------
// export const getFCMToken = async () => {
//   const hasPermission = await requestNotificationPermission();
//   if (!hasPermission) return null;

//   try {
//     if (!messaging().isDeviceRegisteredForRemoteMessages) {
//       await messaging().registerDeviceForRemoteMessages();
//     }

//     const token = await messaging().getToken();
//     console.log('FCM Token:', token);

//     messaging().onTokenRefresh(newToken => {
//       console.log('FCM Token refreshed:', newToken);
//     });

//     return token;
//   } catch (error) {
//     console.error('FCM Token error:', error);
//     return null;
//   }
// };

// // --------------------------------------------------
// // 📩 Show Notification (Used in foreground & background)
// // --------------------------------------------------
// const showLocalNotification = async (remoteMessage) => {
//   await Notifications.scheduleNotificationAsync({
//     content: {
//       title: remoteMessage.data?.title || 'New Message',
//       body: remoteMessage.data?.body || '',
//       categoryIdentifier: 'chat-message', // 👈 Enables Reply
//       data: remoteMessage.data,
//     },
//     trigger: null,
//   });
// };

// // --------------------------------------------------
// // 🟢 Foreground Listener
// // --------------------------------------------------
// export const listenToForegroundMessages = () => {
//   return messaging().onMessage(async remoteMessage => {
//     console.log('Foreground message:', remoteMessage);
//     await showLocalNotification(remoteMessage);
//   });
// };

// // --------------------------------------------------
// // 🌙 Background Handler
// // --------------------------------------------------
// export const registerBackgroundHandler = () => {
//   messaging().setBackgroundMessageHandler(async remoteMessage => {
//     console.log('Background message:', remoteMessage);
//     await showLocalNotification(remoteMessage);
//   });
// };

// // --------------------------------------------------
// // 💬 Handle Reply Action
// // --------------------------------------------------
// export const registerNotificationResponseListener = () => {
//   Notifications.addNotificationResponseReceivedListener(response => {
//     const replyText = response.userText;

//     if (replyText) {
//       console.log('User replied:', replyText);

//       // 🔥 TODO:
//       // Send replyText + response.notification.request.content.data
//       // to your backend API
//     }
//   });
// };