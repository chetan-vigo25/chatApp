import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import ChatList from '../screens/chats/ChatList';
import Profile from '../screens/profiles/Profile';
import AddUser from '../screens/chats/AddUser';
import Setting from '../screens/profiles/Setting';
import BottomTabBar from '../components/BottomTabBar';
import { useTheme } from '../contexts/ThemeContext';
import { useRealtimeChat } from '../contexts/RealtimeChatContext';

const Tab = createBottomTabNavigator();

function CustomTabBar({ state, navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { state: realtimeState } = useRealtimeChat();

  const tabKeys = ['chats', 'contacts', 'profile', 'settings'];
  const activeTab = tabKeys[state.index] || 'chats';

  const handleTabPress = (tabKey) => {
    const routeMap = {
      chats: 'ChatListTab',
      contacts: 'ContactsTab',
      profile: 'ProfileTab',
      settings: 'SettingsTab',
    };
    const routeName = routeMap[tabKey];
    if (!routeName) return;

    const event = navigation.emit({
      type: 'tabPress',
      target: state.routes.find((r) => r.name === routeName)?.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      navigation.navigate(routeName);
    }
  };

  return (
    <BottomTabBar
      activeTab={activeTab}
      onTabPress={handleTabPress}
      theme={theme}
      isDarkMode={isDarkMode}
      unreadCount={Number(realtimeState?.totalUnread || 0)}
    />
  );
}

export default function BottomTabNavigator() {
  return (
    <Tab.Navigator
      tabBar={(props) => <CustomTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        lazy: true,
      }}
      initialRouteName="ChatListTab"
    >
      <Tab.Screen name="ChatListTab" component={ChatList} />
      <Tab.Screen name="ContactsTab" component={AddUser} />
      <Tab.Screen name="ProfileTab" component={Profile} />
      <Tab.Screen name="SettingsTab" component={Setting} />
    </Tab.Navigator>
  );
}