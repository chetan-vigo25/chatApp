import React, { useRef } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { TransitionPresets } from '@react-navigation/stack';
import { navigationRef } from "../Redux/Services/navigationService";

import Splash from "../screens/Splash";
import UserAgree from "../screens/UserAgree";
import Login from "../screens/Login";
import Otp from "../screens/Otp";
import ChatList from "../screens/chats/ChatList";
import ChatScreen from "../screens/chats/ChatScreen";
import AddUser from "../screens/chats/AddUser";
import Profile from "../screens/profiles/Profile";
import Test from "../screens/Test";
import Term from "../screens/Term";
import Privacy from "../screens/Privacy";
import NoInternet from "../screens/NoInternet";
import LinkDevice from "../screens/ActiveDevice/LinkDevice";
import EditProfile from "../screens/profiles/EditProfile";
import PersonalInfoEdit from "../screens/profiles/PersonalInfoEdit";
import Setting from "../screens/profiles/Setting";
import UserB from "../screens/profiles/UserB";
import ChatColorTheme from "../screens/chats/ChatColorTheme";
import ChatMedia from "../screens/chats/ChatMedia";
import AddNewContact from "../screens/chats/AddNewContact";

import { useTheme } from "../contexts/ThemeContext";

const Stack = createStackNavigator();

export default function RootNavigator() {
  const { theme } = useTheme();
  
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <NavigationContainer 
        ref={navigationRef}
        theme={{
          dark: false, // We handle dark mode through our custom theme
          colors: {
            primary: theme.colors.primary,
            background: theme.colors.background,
            card: theme.colors.surface,
            text: theme.colors.text,
            border: theme.colors.border,
            notification: theme.colors.primary,
          },
        }}
      >
        <Stack.Navigator 
          screenOptions={{ 
            headerShown: false,
            cardStyle: { backgroundColor: theme.colors.background },
            gestureEnabled: true,
            gestureResponseDistance: 50,
            ...TransitionPresets.SlideFromRightIOS,
            transitionSpec: {
              open: {
                animation: 'spring',
                config: {
                  damping: 80,
                  stiffness: 500,
                  mass: 3,
                  overshootClamping: false,
                  restDisplacementThreshold: 0.01,
                  restSpeedThreshold: 0.01,
                }
              },
              close: {
                animation: 'spring',
                config: {
                  damping: 80,
                  stiffness: 500,
                  mass: 3,
                  overshootClamping: false,
                  restDisplacementThreshold: 0.01,
                  restSpeedThreshold: 0.01,
                }
              }
            }
          }}
          initialRouteName="Splash"
        >
          <Stack.Screen name="Splash" component={Splash} />
          <Stack.Screen name="UserAgree" component={UserAgree} />
          <Stack.Screen name="Login" component={Login} />
          <Stack.Screen name="Otp" component={Otp} />
          <Stack.Screen name="ChatList" component={ChatList} />
          <Stack.Screen name="ChatScreen" component={ChatScreen} />
          <Stack.Screen name="AddUser" component={AddUser} />
          <Stack.Screen name="Profile" component={Profile} />
          <Stack.Screen name="NoInternet" component={NoInternet} />
          <Stack.Screen name="LinkDevice" component={LinkDevice} />
          <Stack.Screen name="Test" component={Test} />
          <Stack.Screen name="Privacy" component={Privacy} />
          <Stack.Screen name="Term" component={Term} />
          <Stack.Screen name="EditProfile" component={EditProfile} />
          <Stack.Screen name="PersonalInfoEdit" component={PersonalInfoEdit} />
          <Stack.Screen name="Setting" component={Setting} />
          <Stack.Screen name="UserB" component={UserB} />
          <Stack.Screen name="ChatColorTheme" component={ChatColorTheme} />
          <Stack.Screen name="AddNewContact" component={AddNewContact} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  );
}
