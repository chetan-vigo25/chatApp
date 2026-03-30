let firebaseApp = null;

try {
  const { initializeApp } = require('@react-native-firebase/app');
  firebaseApp = initializeApp({});
} catch (error) {
  console.warn('[Firebase] Init failed — google-services.json may be missing:', error?.message);
}

export { firebaseApp };