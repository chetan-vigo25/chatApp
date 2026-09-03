import React, { useState, useEffect } from "react";
import {
  View,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Text,
  Switch,
  Alert,
  ActivityIndicator,
} from 'react-native';
import { useDispatch, useSelector } from "react-redux";
import NetInfo from '@react-native-community/netinfo';

import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { setHideContact } from "../../Redux/Services/Profile/Profile.Services";

// Privacy & Account hub — groups account-level privacy controls and the
// destructive "Delete account" entry point (WhatsApp-style).
export default function PrivacyAccount({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();

  const profile = useSelector((state) => state.profile?.profileData);
  const username = profile?.userName || '';
  const [hideContact, setHide] = useState(Boolean(profile?.privacySettings?.hideContact));
  const [busy, setBusy] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // Keep the switch in step with the server after a profileDetail() refresh.
  useEffect(() => {
    setHide(Boolean(profile?.privacySettings?.hideContact));
  }, [profile?.privacySettings?.hideContact]);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return () => unsubscribe();
  }, []);

  /**
   * Toggle "hide my phone number and email".
   *
   * ONLINE ONLY, and never queued through the outbox — the server rejects the
   * enable outright when there is no username, so a queued toggle would surface
   * as a confusing delayed failure.
   *
   * Turning it ON without a username routes to the username screen first: with
   * the toggle on and no handle, non-contacts would be shown nothing at all
   * where the number used to be.
   */
  const onToggleHideContact = async (next) => {
    if (busy) return;
    if (!isOnline) {
      Alert.alert('You are offline', 'Connect to the internet to change this setting.');
      return;
    }
    if (next && !username) {
      Alert.alert(
        'Choose a username first',
        'Everyone will see your username in place of your name and number, so you need one before you can turn this on.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Set username',
            onPress: () => navigation.navigate('UsernameEdit', { returnToPrivacy: true }),
          },
        ]
      );
      return;
    }

    // Optimistic: flip immediately, roll back if the server refuses.
    setHide(next);
    setBusy(true);
    try {
      await setHideContact(next);
      await dispatch(profileDetail());
    } catch (error) {
      setHide(!next);
      Alert.alert('Could not update', error?.message || 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const iconColor = theme.colors.iconColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const sepClr = isDarkMode ? "rgba(255,255,255,0.07)" : "rgba(15,30,50,0.07)";

  const items = [
    {
      icon: "at-outline",
      label: "Username",
      subtitle: username ? `@${username}` : "Choose a public username",
      onPress: () => navigation.navigate("UsernameEdit"),
    },
    {
      icon: "person-remove-outline",
      label: "Blocked Contacts",
      subtitle: "Manage who you've blocked",
      onPress: () => navigation.navigate("BlockedContacts"),
    },
    {
      icon: "phone-portrait-outline",
      label: "Linked Devices",
      subtitle: "Devices logged into your account",
      onPress: () => navigation.navigate("LinkDevice"),
    },
    {
      icon: "trash-outline",
      label: "Delete Account",
      subtitle: "Permanently delete your account",
      destructive: true,
      onPress: () => navigation.navigate("DeleteAccount"),
    },
  ];

  const renderItem = (item, isLast) => {
    const color = item.destructive ? theme.colors.danger : primaryText;
    const icon = item.destructive ? theme.colors.danger : iconColor;
    return (
      <View key={item.label}>
        <TouchableOpacity onPress={item.onPress} activeOpacity={0.6} style={styles.menuItem}>
          <View style={styles.menuIconWrap}>
            <Ionicons name={item.icon} size={23} color={icon} />
          </View>
          <View style={styles.menuTextWrap}>
            <Text style={[styles.menuLabel, { color }]}>{item.label}</Text>
            {item.subtitle ? (
              <Text numberOfLines={1} style={[styles.menuSubtitle, { color: subText }]}>
                {item.subtitle}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={subText} />
        </TouchableOpacity>
        {!isLast && <View style={[styles.separator, { backgroundColor: sepClr }]} />}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Privacy & Account</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={[styles.sectionCard, { backgroundColor: cardBg, marginBottom: 12 }]}>
          {/* The toggle is only USABLE once a username exists — with it on and no
              handle, other people would see nothing at all where the name and
              number were. Until then the row is dimmed and tapping it goes to
              set one, rather than letting the user flip a switch the server
              would refuse.

              COPY: the toggle hides the account from EVERYONE, saved contacts
              included — say so plainly. Wording that promises "only people who
              haven't saved you" would be a privacy promise the code does not
              make (it makes a STRONGER one), and users decide based on it. */}
          <TouchableOpacity
            activeOpacity={username ? 1 : 0.6}
            disabled={Boolean(username)}
            onPress={() => navigation.navigate("UsernameEdit", { returnToPrivacy: true })}
            style={styles.menuItem}
          >
            <View style={styles.menuIconWrap}>
              <Ionicons name="eye-off-outline" size={23} color={iconColor} />
            </View>
            <View style={styles.menuTextWrap}>
              <Text style={[styles.menuLabel, { color: primaryText }]}>
                Hide phone number & email
              </Text>
              <Text style={[styles.menuSubtitle, { color: subText }]}>
                {!username
                  ? "Set a username first — tap here"
                  : hideContact
                    ? `Everyone sees @${username} instead of your name and number`
                    : "Off — people see your name or number as usual"}
              </Text>
            </View>
            {busy ? (
              <ActivityIndicator size="small" color={theme.colors.primary} />
            ) : (
              <View style={!username || !isOnline ? { opacity: theme.colors.disabledOpacity } : null}>
                {/* Colours match every other Switch in the app
                    (presence/PrivacySettingsScreen, TwoStepPassword).
                    The first version used `sepClr` for the OFF track and
                    `colors.background` for the thumb — both near-black in dark
                    mode, so the switch was invisible against the card and the
                    row read as having no control at all. A control the user
                    cannot see is a control that does not exist. */}
                <Switch
                  value={hideContact}
                  onValueChange={onToggleHideContact}
                  disabled={busy || !isOnline || !username}
                  trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
                  thumbColor="#ffffff"
                  ios_backgroundColor={theme.colors.border}
                />
              </View>
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
          {items.map((item, i) => renderItem(item, i === items.length - 1))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
  },
  headerBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontFamily: "Roboto-Bold", fontSize: 22, letterSpacing: -0.3 },
  headerSpacer: { width: 40 },
  scrollContent: { paddingHorizontal: 12, paddingBottom: 40, paddingTop: 8 },
  sectionCard: { borderRadius: 14, overflow: "hidden" },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 14,
    gap: 16,
    minHeight: 58,
  },
  menuIconWrap: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  menuTextWrap: { flex: 1 },
  menuLabel: { fontFamily: "Roboto-Regular", fontSize: 16, lineHeight: 21 },
  menuSubtitle: { fontFamily: "Roboto-Regular", fontSize: 13, marginTop: 2, lineHeight: 17 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
});
