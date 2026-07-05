import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import {
  createNavigatorFactory,
  useNavigationBuilder,
  TabRouter,
} from '@react-navigation/native';
import {
  GestureHandlerRootView,
  Gesture,
  GestureDetector,
} from 'react-native-gesture-handler';
import Reanimated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import ChatList from '../screens/chats/ChatList';
import Profile from '../screens/profiles/Profile';
import AddUser from '../screens/chats/AddUser';
import Setting from '../screens/profiles/Setting';
import StatusList from '../screens/status/StatusList';
import CallsScreen from '../screens/calls/CallsScreen';
import BottomTabBar from '../components/BottomTabBar';
import { useTheme } from '../contexts/ThemeContext';
import { useRealtimeChat } from '../contexts/RealtimeChatContext';
import { useMissedCallBadge, startMissedCallTracking } from '../calls/services/missedCallBadge';

const SCREEN_W = Dimensions.get('window').width;

// A decisive swipe (past this distance OR fast enough) commits to the adjacent
// tab; anything less springs back to the current one.
const COMMIT_DISTANCE = SCREEN_W * 0.28;
const COMMIT_VELOCITY = 520;

// ---------------------------------------------------------------------------
// Bottom tab bar rendered by our custom navigator (same look/behaviour as the
// old CustomTabBar). Tapping a tab is INSTANT (no slide) — see TabPager, which
// snaps to a tab's page immediately on any index change that isn't a swipe.
// ---------------------------------------------------------------------------
function CustomTabBar({ state, navigation }) {
  const { theme, isDarkMode } = useTheme();
  const { state: realtimeState } = useRealtimeChat();
  const missedCallCount = useMissedCallBadge();

  // Track unseen missed calls for the Calls-tab badge for as long as the tab bar
  // is mounted (i.e. the whole time the user is inside the app shell). Cleared
  // when the Calls tab gains focus (CallsScreen).
  useEffect(() => startMissedCallTracking(), []);

  // Order MUST match the <Tab.Screen> registration order below — `state.index`
  // is the position of the active route in that list.
  const tabKeys = ['chats', 'status', 'calls', 'settings', 'contacts', 'profile'];
  const activeTab = tabKeys[state.index] || 'chats';

  const handleTabPress = (tabKey) => {
    const routeMap = {
      chats: 'ChatListTab',
      status: 'StatusTab',
      settings: 'SettingsTab',
      calls: 'CallsTab',
      contacts: 'ContactsTab',
      profile: 'ProfileTab',
    };
    const routeName = routeMap[tabKey];
    if (!routeName) return;

    const target = state.routes.find((r) => r.name === routeName)?.key;
    const event = navigation.emit({
      type: 'tabPress',
      target,
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
      missedCallCount={Number(missedCallCount || 0)}
    />
  );
}

// ---------------------------------------------------------------------------
// The pager. All tab screens live side-by-side in a single horizontal strip
// (width = N * screenWidth). We translate the whole strip so that the active
// tab sits in the viewport. A pan gesture drags the strip WITH the finger, so
// the adjacent screen is already on-screen and joined edge-to-edge — no black
// gap. Releasing past the threshold animates to the neighbour and syncs the
// navigation state; a tap on the tab bar snaps instantly (no slide).
//
// To avoid mounting every heavy screen up front, a slot only renders its screen
// once it enters the active tab's window (current ± 1); once mounted it stays
// mounted (like a lazy tab navigator) so re-reveals are instant.
// ---------------------------------------------------------------------------
function TabPager({ state, descriptors, navigation }) {
  const { theme } = useTheme();
  const bg = theme?.colors?.background || '#ffffff';

  const index = state.index;
  const count = state.routes.length;

  // Strip translateX. Rest position for tab i is -i * SCREEN_W.
  const offset = useSharedValue(-index * SCREEN_W);
  // Strip position captured at gesture start, so onUpdate is relative to it.
  const startX = useSharedValue(-index * SCREEN_W);
  // Active index mirrored on the UI thread for the gesture worklets.
  const idxSV = useSharedValue(index);

  // Which slots have ever been mounted. Grows to include the active window.
  const [mounted, setMounted] = useState(() => {
    const s = new Set([index]);
    if (index > 0) s.add(index - 1);
    if (index < count - 1) s.add(index + 1);
    return s;
  });

  // On ANY index change (swipe-commit, tab tap, or external navigate) snap the
  // strip to that tab. After a swipe the strip is already animated to exactly
  // this offset, so the snap is a no-op (seamless); after a tap/navigate it
  // jumps instantly — that's the intended "instant, no slide" for taps.
  useEffect(() => {
    idxSV.value = index;
    offset.value = -index * SCREEN_W;
    setMounted((prev) => {
      if (
        prev.has(index) &&
        (index === 0 || prev.has(index - 1)) &&
        (index === count - 1 || prev.has(index + 1))
      ) {
        return prev; // window already mounted — no re-render
      }
      const s = new Set(prev);
      s.add(index);
      if (index > 0) s.add(index - 1);
      if (index < count - 1) s.add(index + 1);
      return s;
    });
  }, [index, count, offset, idxSV]);

  const goToIndex = useCallback(
    (target) => {
      if (target < 0 || target >= count || target === state.index) return;
      const route = state.routes[target];
      const event = navigation.emit({
        type: 'tabPress',
        target: route.key,
        canPreventDefault: true,
      });
      if (!event.defaultPrevented) {
        navigation.navigate(route.name);
      }
    },
    [count, navigation, state.index, state.routes]
  );

  const pan = Gesture.Pan()
    .activeOffsetX([-16, 16])
    .failOffsetY([-18, 18])
    .onBegin(() => {
      'worklet';
      startX.value = offset.value;
    })
    .onUpdate((e) => {
      'worklet';
      const cur = idxSV.value;
      let next = startX.value + e.translationX;
      const min = -(count - 1) * SCREEN_W;
      const max = 0;
      // Rubber-band past the first / last tab so there's give but no over-scroll
      // into empty space.
      const atFirst = cur === 0 && e.translationX > 0;
      const atLast = cur === count - 1 && e.translationX < 0;
      if (atFirst || atLast) {
        next = startX.value + e.translationX * 0.25;
      } else {
        if (next > max) next = max + (next - max) * 0.25;
        if (next < min) next = min + (next - min) * 0.25;
      }
      offset.value = next;
    })
    .onEnd((e) => {
      'worklet';
      const cur = idxSV.value;
      const decisive =
        Math.abs(e.translationX) > COMMIT_DISTANCE ||
        Math.abs(e.velocityX) > COMMIT_VELOCITY;
      let target = cur;
      if (decisive) {
        if (e.translationX < 0 && cur < count - 1) target = cur + 1; // swipe left → next
        else if (e.translationX > 0 && cur > 0) target = cur - 1; // swipe right → prev
      }
      if (target !== cur) {
        offset.value = withTiming(
          -target * SCREEN_W,
          { duration: 190 },
          (finished) => {
            if (finished) runOnJS(goToIndex)(target);
          }
        );
      } else {
        offset.value = withSpring(-cur * SCREEN_W, {
          damping: 22,
          stiffness: 220,
          overshootClamping: true,
        });
      }
    });

  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.value }],
  }));

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      <View style={styles.viewport}>
        <GestureDetector gesture={pan}>
          <Reanimated.View
            style={[
              styles.strip,
              { width: count * SCREEN_W, backgroundColor: bg },
              stripStyle,
            ]}
          >
            {state.routes.map((route, i) => (
              <View
                key={route.key}
                style={[styles.slot, { width: SCREEN_W, backgroundColor: bg }]}
              >
                {mounted.has(i) ? descriptors[route.key].render() : null}
              </View>
            ))}
          </Reanimated.View>
        </GestureDetector>
      </View>
      <CustomTabBar state={state} navigation={navigation} />
    </View>
  );
}

// Custom tab navigator built on React Navigation's own TabRouter, so it is a
// FIRST-CLASS navigator: `navigation.navigate('ProfileTab')`, tab state,
// deep-link resets etc. keep working exactly as with createBottomTabNavigator.
// We just render the scenes ourselves (TabPager) to get true finger-following
// paging without react-native-pager-view / a native rebuild.
function SwipeTabNavigatorInner({
  id,
  initialRouteName,
  backBehavior,
  children,
  screenListeners,
  screenOptions,
  ...rest
}) {
  const { state, descriptors, navigation, NavigationContent } = useNavigationBuilder(
    TabRouter,
    {
      id,
      initialRouteName,
      backBehavior,
      children,
      screenListeners,
      screenOptions,
    }
  );

  return (
    <NavigationContent>
      <TabPager
        {...rest}
        state={state}
        descriptors={descriptors}
        navigation={navigation}
      />
    </NavigationContent>
  );
}

const createSwipeTabNavigator = createNavigatorFactory(SwipeTabNavigatorInner);

const Tab = createSwipeTabNavigator();

// Tab route order — MUST match the <Tab.Screen> registration order below and
// the tabKeys order in CustomTabBar.
export default function BottomTabNavigator() {
  const { theme } = useTheme();
  const bg = theme?.colors?.background || '#ffffff';
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: bg }}>
      <Tab.Navigator
        initialRouteName="ChatListTab"
        screenOptions={{ headerShown: false }}
      >
        <Tab.Screen name="ChatListTab" component={ChatList} />
        <Tab.Screen name="StatusTab" component={StatusList} />
        <Tab.Screen name="CallsTab" component={CallsScreen} />
        <Tab.Screen name="SettingsTab" component={Setting} />
        <Tab.Screen name="ContactsTab" component={AddUser} />
        <Tab.Screen name="ProfileTab" component={Profile} />
      </Tab.Navigator>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  viewport: { flex: 1, overflow: 'hidden' },
  strip: { flex: 1, flexDirection: 'row' },
  slot: { height: '100%' },
});
