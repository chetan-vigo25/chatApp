import React, { useRef } from "react";
import { Platform } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator, CardStyleInterpolators } from "@react-navigation/stack";
import { SafeAreaView } from "react-native-safe-area-context";
import { navigationRef, updateNavigationSnapshot } from "../Redux/Services/navigationService";

import Splash from "../screens/Splash";
import UserAgree from "../screens/UserAgree";
import Login from "../screens/Login";
import LoginEmail from "../screens/LoginEmail";
import Otp from "../screens/Otp";
import ChatScreen from "../screens/chats/ChatScreen";
import Test from "../screens/Test";
import Term from "../screens/Term";
import Privacy from "../screens/Privacy";
import NoInternet from "../screens/NoInternet";
import { LinkedDevicesScreen, QRScannerScreen } from "../features/device-linking";
import DeviceLinkSuccess from "../screens/ActiveDevice/SuccessScreen";
import LinkDevice from "../screens/ActiveDevice/LinkDevice";
import EditProfile from "../screens/profiles/EditProfile";
import PersonalInfoEdit from "../screens/profiles/PersonalInfoEdit";
import UserB from "../screens/profiles/UserB";
import ChatColorTheme from "../screens/chats/ChatColorTheme";
import ChatPrivacy from "../screens/profiles/ChatPrivacy";
import PrivacyAccount from "../screens/profiles/PrivacyAccount";
import BlockedContacts from "../screens/profiles/BlockedContacts";
import DeleteAccount from "../screens/profiles/DeleteAccount";
import HelpSupport from "../screens/support/HelpSupport";
import SupportFaqs from "../screens/support/SupportFaqs";
import CreateTicket from "../screens/support/CreateTicket";
import MyTickets from "../screens/support/MyTickets";
import TicketChat from "../screens/support/TicketChat";
import MyReports from "../screens/profiles/MyReports";
import DeletedChatsPassword from "../screens/profiles/DeletedChatsPassword";
import TwoStepPassword from "../screens/profiles/TwoStepPassword";
import DeletedChatsSelector from "../screens/profiles/DeletedChatsSelector";
import ChatMedia from "../screens/chats/ChatMedia";
import AddNewContact from "../screens/chats/AddNewContact";
import ArchivedChats from "../screens/chats/ArchivedChats";
import StatusScreen from "../screens/presence/StatusScreen";
import ContactsPresenceScreen from "../screens/presence/ContactsPresenceScreen";
import SessionsScreen from "../screens/presence/SessionsScreen";
import PrivacySettingsScreen from "../screens/presence/PrivacySettingsScreen";
import CreateGroup from "../screens/group/CreateGroup";
import GroupInfo from "../screens/group/GroupInfo";
import EditGroup from "../screens/group/EditGroup";
import AddGroupMembers from "../screens/group/AddGroupMembers";
import ForwardMessageScreen from "../screens/chats/ForwardMessageScreen";
import MessageInfoScreen from "../screens/chats/MessageInfoScreen";
import SyncScreen from "../screens/SyncScreen";
import StatusListScreen from "../screens/status/StatusList";
import StatusCreateScreen from "../screens/status/StatusCreate";
import StatusCustomiseScreen from "../screens/status/StatusCustomise";
import StatusPreviewScreen from "../screens/status/StatusPreview";
import StatusViewerScreen from "../screens/status/StatusViewer";
import CallDetailScreen from "../screens/calls/CallDetailScreen";
import NewCallScreen from "../screens/calls/NewCallScreen";

import BottomTabNavigator from "./BottomTabNavigator";

import { useTheme } from "../contexts/ThemeContext";

const Stack = createStackNavigator();

export default function RootNavigator() {
  const { theme, isDarkMode } = useTheme();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <NavigationContainer
        ref={navigationRef}
        onReady={updateNavigationSnapshot}
        onStateChange={updateNavigationSnapshot}
        theme={{
          dark: isDarkMode,
          colors: {
            primary: theme.colors.themeColor,
            background: theme.colors.background,
            card: theme.colors.surface,
            text: theme.colors.primaryTextColor,
            border: theme.colors.border,
            notification: theme.colors.themeColor,
          },
        }}
      >
        <Stack.Navigator
          screenOptions={{
            headerShown: false,
            cardStyle: { backgroundColor: theme.colors.background },
            gestureEnabled: Platform.OS === 'ios',
            gestureResponseDistance: 50,
            // Instant, lightweight transitions — no heavy spring/slide
            animationEnabled: true,
            cardStyleInterpolator: CardStyleInterpolators.forFadeFromCenter,
            transitionSpec: {
              open: { animation: 'timing', config: { duration: 150 } },
              close: { animation: 'timing', config: { duration: 120 } },
            },
            // Detach inactive screens to free memory
            detachPreviousScreen: true,
          }}
          initialRouteName="Splash"
        >
          <Stack.Screen name="Splash" component={Splash} />
          <Stack.Screen name="UserAgree" component={UserAgree} />
          <Stack.Screen name="Login" component={Login} />
          <Stack.Screen name="LoginEmail" component={LoginEmail} />
          <Stack.Screen name="Otp" component={Otp} />
          <Stack.Screen name="SyncScreen" component={SyncScreen} />
          <Stack.Screen name="ChatList" component={BottomTabNavigator} />
          <Stack.Screen name="ChatScreen" component={ChatScreen} />
          <Stack.Screen name="NoInternet" component={NoInternet} />
          <Stack.Screen name="LinkDevice" component={LinkedDevicesScreen} />
          <Stack.Screen name="QRScanner" component={QRScannerScreen} />
          <Stack.Screen name="DeviceLinkSuccess" component={DeviceLinkSuccess} />
          <Stack.Screen name="Test" component={Test} />
          <Stack.Screen name="Privacy" component={Privacy} />
          <Stack.Screen name="Term" component={Term} />
          <Stack.Screen name="EditProfile" component={EditProfile} />
          <Stack.Screen name="PersonalInfoEdit" component={PersonalInfoEdit} />
          <Stack.Screen name="UserB" component={UserB} />
          <Stack.Screen name="ChatColorTheme" component={ChatColorTheme} />
          <Stack.Screen name="ChatPrivacy" component={ChatPrivacy} />
          <Stack.Screen name="PrivacyAccount" component={PrivacyAccount} />
          <Stack.Screen name="BlockedContacts" component={BlockedContacts} />
          <Stack.Screen name="DeleteAccount" component={DeleteAccount} />
          <Stack.Screen name="HelpSupport" component={HelpSupport} />
          <Stack.Screen name="SupportFaqs" component={SupportFaqs} />
          <Stack.Screen name="CreateTicket" component={CreateTicket} />
          <Stack.Screen name="MyTickets" component={MyTickets} />
          <Stack.Screen name="TicketChat" component={TicketChat} />
          <Stack.Screen name="MyReports" component={MyReports} />
          <Stack.Screen name="DeletedChatsPassword" component={DeletedChatsPassword} />
          <Stack.Screen name="TwoStepPassword" component={TwoStepPassword} />
          <Stack.Screen
            name="DeletedChatsSelector"
            component={DeletedChatsSelector}
            options={{ gestureEnabled: false }}
          />
          <Stack.Screen name="ArchivedChats" component={ArchivedChats} />
          <Stack.Screen name="AddNewContact" component={AddNewContact} />
          <Stack.Screen name="StatusScreen" component={StatusScreen} />
          <Stack.Screen name="ContactsPresenceScreen" component={ContactsPresenceScreen} />
          <Stack.Screen name="SessionsScreen" component={SessionsScreen} />
          <Stack.Screen name="PrivacySettingsScreen" component={PrivacySettingsScreen} />
          <Stack.Screen name="CreateGroup" component={CreateGroup} />
          <Stack.Screen name="GroupInfo" component={GroupInfo} />
          <Stack.Screen name="EditGroup" component={EditGroup} />
          <Stack.Screen name="AddGroupMembers" component={AddGroupMembers} />
          <Stack.Screen name="ForwardMessage" component={ForwardMessageScreen} />
          <Stack.Screen name="MessageInfo" component={MessageInfoScreen} />
          <Stack.Screen name="StatusListScreen" component={StatusListScreen} />
          <Stack.Screen
            name="StatusCreate"
            component={StatusCreateScreen}
            options={{
              // WhatsApp-style: slides up from the bottom as a sheet over the
              // Updates list, which stays visible behind the dimmed top strip.
              presentation: 'transparentModal',
              gestureEnabled: true,
              gestureDirection: 'vertical',
              cardOverlayEnabled: false,
              cardStyle: { backgroundColor: 'transparent' },
              // Keep the screen below (the Updates/Status tab) mounted and
              // visible behind the transparent sheet. The navigator default is
              // detachPreviousScreen:true, which would otherwise blank it to gray.
              detachPreviousScreen: false,
              cardStyleInterpolator: CardStyleInterpolators.forBottomSheetAndroid,
            }}
          />
          <Stack.Screen name="StatusCustomise" component={StatusCustomiseScreen} />
          <Stack.Screen name="StatusPreview"   component={StatusPreviewScreen} />
          <Stack.Screen name="StatusViewer"    component={StatusViewerScreen} options={{ gestureEnabled: false }} />
          <Stack.Screen name="CallDetail"      component={CallDetailScreen} />
          <Stack.Screen name="NewCall"         component={NewCallScreen} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaView>
  );
}