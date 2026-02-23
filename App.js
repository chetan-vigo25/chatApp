import React, { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView, SafeAreaProvider } from 'react-native-safe-area-context';
import RootNavigator from './src/navigations/RootNavigator';
import { useFonts } from 'expo-font';
import { ThemeProvider, useTheme } from './src/contexts/ThemeContext';
import { ContactProvider } from './src/contexts/ContactContext';
import { DeviceInfoProvider } from './src/contexts/DeviceInfoContext';
import { Provider as PaperProvider } from 'react-native-paper';
import { NetworkProvider, useNetwork } from './src/contexts/NetworkContext';
import { DeviceLocationProvider } from './src/contexts/DeviceLoc';
import { ImageProvider } from './src/contexts/ImageProvider';
import 'react-native-get-random-values';

import NoInternet from './src/screens/NoInternet';

import 'react-native-gesture-handler';

function AppContent() {
  const { theme, isDarkMode } = useTheme();
  const { isConnected } = useNetwork();

  const [fontsLoaded] = useFonts({
    'Roboto-Bold': require('./assets/fonts/Roboto-Bold.ttf'),
    'Roboto-Light': require('./assets/fonts/Roboto-Light.ttf'),
    'Roboto-Medium': require('./assets/fonts/Roboto-Medium.ttf'),
    'Roboto-Regular': require('./assets/fonts/Roboto-Regular.ttf'),
    'Roboto-SemiBold': require('./assets/fonts/Roboto-SemiBold.ttf'),
    'Poppins-Regular': require('./assets/fonts/Poppins-Regular.ttf'),
    'Poppins-Bold': require('./assets/fonts/Poppins-Bold.ttf'),
    'Poppins-Medium': require('./assets/fonts/Poppins-Medium.ttf'),
    'Poppins-SemiBold': require('./assets/fonts/Poppins-SemiBold.ttf'),
  });

  if (!fontsLoaded) {
    return null; // or splash screen
  }

  if (!isConnected) {
    return <NoInternet />;
  }
  return (
    <SafeAreaProvider style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <RootNavigator />
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </SafeAreaProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <NetworkProvider>
       <PaperProvider>
         <DeviceInfoProvider>
           <ContactProvider>
            <ImageProvider>
             <DeviceLocationProvider>
                <AppContent />
             </DeviceLocationProvider>
            </ImageProvider>
           </ContactProvider>
         </DeviceInfoProvider>
       </PaperProvider>
      </NetworkProvider>
    </ThemeProvider>
  );
}
