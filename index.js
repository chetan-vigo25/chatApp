// import { registerRootComponent } from 'expo';

// import App from './App';

// // registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// // It also ensures that whether you load the app in Expo Go or in a native build,
// // the environment is set up appropriately
// registerRootComponent(App);


import { registerRootComponent } from 'expo';
import { Provider } from 'react-redux';
import App from './App';
import store from './src/Redux/Store';
import { registerBackgroundHandler } from './src/firebase/fcmService';
import { registerNotifeeBackground } from './src/firebase/callNotifee';

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