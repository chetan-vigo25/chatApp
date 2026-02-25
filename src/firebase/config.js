import { initializeApp } from '@react-native-firebase/app';

// No extra config needed if using google-services.json
// Firebase will auto-initialize from Android/iOS config
export const firebaseApp = initializeApp({});