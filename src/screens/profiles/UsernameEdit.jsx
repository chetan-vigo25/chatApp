import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View, Text, TouchableOpacity, Alert, Platform, ToastAndroid,
  ActivityIndicator, TextInput, StyleSheet, KeyboardAvoidingView,
} from "react-native";
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import NetInfo from '@react-native-community/netinfo';
import { useDispatch, useSelector } from "react-redux";

import { useTheme } from "../../contexts/ThemeContext";
import { profileDetail } from "../../Redux/Reducer/Profile/Profile.reducer";
import { checkUsernameAvailability, setUsername } from "../../Redux/Services/Profile/Profile.Services";
import { validateUsername, normalizeUsername, USERNAME_MAX } from "../../utils/usernameRules";

function showToast(message) {
  if (Platform.OS === 'android') ToastAndroid.show(message, ToastAndroid.SHORT);
  else Alert.alert('', message);
}

const DEBOUNCE_MS = 450;

/**
 * Set or change the public username (the "@handle").
 *
 * ONLINE ONLY. The claim is decided by a unique index on the server, so it can
 * never be queued through the offline outbox — a replayed claim could resurrect
 * a handle someone else has legitimately taken in the meantime. The save button
 * disables itself while offline and says so.
 *
 * The availability check is ADVISORY: a name shown as available can still come
 * back USERNAME_TAKEN if another device claims it first, and that is handled as
 * a normal, recoverable outcome rather than an error state.
 */
export default function UsernameEdit({ navigation, route }) {
  const { theme } = useTheme();
  const dispatch = useDispatch();

  const currentUsername = useSelector(
    (state) => state.profile?.profileData?.userName || ''
  );
  // Set when the user arrived here because they tried to turn on the privacy
  // toggle without a handle — we send them straight back once they have one.
  const returnToPrivacy = route?.params?.returnToPrivacy === true;

  const [value, setValue] = useState(currentUsername);
  const [checking, setChecking] = useState(false);
  const [hint, setHint] = useState(null);      // { ok: boolean, text: string }
  const [saving, setSaving] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  const debounceRef = useRef(null);
  const requestSeq = useRef(0);

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setIsOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const runAvailabilityCheck = useCallback((candidate) => {
    const local = validateUsername(candidate);
    if (!local.ok) {
      setChecking(false);
      setHint({ ok: false, text: local.message });
      return;
    }
    if (local.value === normalizeUsername(currentUsername)) {
      setChecking(false);
      setHint({ ok: true, text: 'This is your current username.' });
      return;
    }
    setChecking(true);
    // Guards against an earlier, slower response overwriting a newer one.
    const seq = ++requestSeq.current;
    checkUsernameAvailability(local.value).then((result) => {
      if (seq !== requestSeq.current) return;
      setChecking(false);
      if (!result) { setHint(null); return; }   // check failed — say nothing
      setHint(
        result.available
          ? { ok: true, text: `@${local.value} is available` }
          : { ok: false, text: result.message || 'This username is already taken.' }
      );
    });
  }, [currentUsername]);

  const handleChange = (text) => {
    // Normalize as they type so what they see is what gets stored.
    const next = text.replace(/\s/g, '').toLowerCase().slice(0, USERNAME_MAX);
    setValue(next);
    setHint(null);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!next) { setChecking(false); return; }
    debounceRef.current = setTimeout(() => runAvailabilityCheck(next), DEBOUNCE_MS);
  };

  const handleSave = async () => {
    const local = validateUsername(value);
    if (!local.ok) { setHint({ ok: false, text: local.message }); return; }
    if (!isOnline) {
      setHint({ ok: false, text: 'You need to be online to set a username.' });
      return;
    }

    setSaving(true);
    try {
      await setUsername(local.value);
      await dispatch(profileDetail());
      showToast('Username updated');
      if (returnToPrivacy) navigation.navigate('PrivacyAccount');
      else navigation.goBack();
    } catch (error) {
      // A lost race is expected, not exceptional — re-prompt in place and leave
      // what they typed so they can tweak it.
      if (error?.code === 'USERNAME_TAKEN') {
        setHint({ ok: false, text: 'Someone just took that username. Try another.' });
      } else if (error?.code === 'USERNAME_RATE_LIMITED') {
        setHint({ ok: false, text: error.message });
      } else {
        setHint({ ok: false, text: error?.message || 'Could not save. Please try again.' });
      }
    } finally {
      setSaving(false);
    }
  };

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const canSave = !saving && isOnline && validateUsername(value).ok
    && normalizeUsername(value) !== normalizeUsername(currentUsername);

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.colors.background }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} hitSlop={styles.hitSlop}>
          <Ionicons name="arrow-back" size={24} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Username</Text>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.body}
      >
        <View style={[styles.inputRow, { borderBottomColor: theme.colors.primary }]}>
          <Text style={[styles.at, { color: subText }]}>@</Text>
          <TextInput
            value={value}
            onChangeText={handleChange}
            placeholder="username"
            placeholderTextColor={subText}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={USERNAME_MAX}
            style={[styles.input, { color: primaryText }]}
          />
          {checking ? <ActivityIndicator size="small" color={theme.colors.primary} /> : null}
        </View>

        {hint ? (
          <Text style={[styles.hint, { color: hint.ok ? theme.colors.primary : theme.colors.danger }]}>
            {hint.text}
          </Text>
        ) : (
          <Text style={[styles.hint, { color: subText }]}>
            Letters, numbers, underscores and periods. 3-30 characters.
          </Text>
        )}

        {!isOnline ? (
          <Text style={[styles.offline, { color: theme.colors.danger }]}>
            You are offline. A username can only be set while connected.
          </Text>
        ) : null}

        <TouchableOpacity
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={0.7}
          style={[
            styles.saveBtn,
            {
              backgroundColor: theme.colors.primary,
              // The theme exposes `disabledOpacity`, not a disabled colour —
              // dim the brand colour rather than inventing a hardcoded grey.
              opacity: canSave ? 1 : theme.colors.disabledOpacity,
            },
          ]}
        >
          {saving
            ? <ActivityIndicator size="small" color="#fff" />
            : <Text style={styles.saveLabel}>Save</Text>}
        </TouchableOpacity>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  headerTitle: { fontSize: 19, fontWeight: '600', marginLeft: 18 },
  hitSlop: { top: 10, bottom: 10, left: 10, right: 10 },
  body: { flex: 1, paddingHorizontal: 20, paddingTop: 12 },
  inputRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1.5, paddingBottom: 6 },
  at: { fontSize: 17, marginRight: 2 },
  input: { flex: 1, fontSize: 17, paddingVertical: 6 },
  hint: { fontSize: 13, marginTop: 10, lineHeight: 18 },
  offline: { fontSize: 13, marginTop: 8 },
  saveBtn: { marginTop: 28, borderRadius: 24, paddingVertical: 13, alignItems: 'center' },
  saveLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
