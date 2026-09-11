// import { registerRootComponent } from 'expo';
 
// import App from './App';
 
// // registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// // It also ensures that whether you load the app in Expo Go or in a native build,
// // the environment is set up appropriately
// registerRootComponent(App);
 
 
// FIRST import — installs a targeted console.warn filter for known, accepted
// deprecation notices (expo-av) that fire at module-import time. See the
// module's header before adding anything to its list.
import './src/utils/silenceKnownDeprecationWarnings';
import { registerRootComponent } from 'expo';
import { Provider } from 'react-redux';
import App from './App';
import store from './src/Redux/Store';
import { registerBackgroundHandler } from './src/firebase/fcmService';
import { registerNotifeeBackground } from './src/firebase/callNotifee';
 
// Global JS error hook: log every uncaught error (fatal or not) with its stack,
// then CHAIN to the previous handler — React Native's own handler is what shows
// the red box in dev and terminates on a fatal error in release. Swallowing it
// here would leave the app running in a corrupt state.
if (global.ErrorUtils && typeof global.ErrorUtils.setGlobalHandler === 'function') {
  const previousGlobalHandler = typeof global.ErrorUtils.getGlobalHandler === 'function'
    ? global.ErrorUtils.getGlobalHandler()
    : null;
  global.ErrorUtils.setGlobalHandler((error, isFatal) => {
    try {
      console.error(`[GlobalError]${isFatal ? '[fatal]' : ''}`, error?.message || error, error?.stack);
    } catch (_) { /* logging must never throw */ }
    if (typeof previousGlobalHandler === 'function') {
      previousGlobalHandler(error, isFatal);
    }
  });
}

// Must run at module top-level (before the app renders) so FCM can deliver
// data/background messages — including incoming-call wake pushes — when the app
// is backgrounded or killed.
registerBackgroundHandler();
// notifee's background event handler (Decline/Accept on the full-screen call
// notification when the app is backgrounded or killed) must also be registered
// at top level — notifee requires this before any background event fires.
registerNotifeeBackground();
 
const RootApp = () => (
  <Provider store={store}>
    <App />
  </Provider>
);
 
registerRootComponent(RootApp);
 