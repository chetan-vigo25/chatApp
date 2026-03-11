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

// Register FCM background handler at top-level BEFORE component registration
// This is required because when the app is killed/background, React components aren't mounted
registerBackgroundHandler();

const RootApp = () => (
  <Provider store={store}>
    <App />
  </Provider>
);

registerRootComponent(RootApp);
