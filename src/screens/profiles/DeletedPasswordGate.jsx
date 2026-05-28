import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, Animated,
  ActivityIndicator, KeyboardAvoidingView, Platform, BackHandler,
} from 'react-native';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import { verifyDeletedPassword } from '../../Redux/Services/Profile/Settings.Services';

export default function DeletedPasswordGate({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const shakeAnim = useRef(new Animated.Value(0)).current;

  const [pwd, setPwd] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    Animated.timing(fadeAnim, {
      toValue: 1, duration: 350, useNativeDriver: true,
    }).start();

    // The gate sits on top of the auth flow — back button must not pop
    // back into the splash/auth stack. Swallow it; users can use "Skip".
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const goToChatList = () => {
    navigation.reset({ index: 0, routes: [{ name: 'ChatList' }] });
  };

  const shake = () => {
    Animated.sequence([
      Animated.timing(shakeAnim, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: -6, duration: 50, useNativeDriver: true }),
      Animated.timing(shakeAnim, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  };

  const handleSubmit = async () => {
    const candidate = pwd.trim();
    if (!candidate) {
      setError('Enter your password.');
      shake();
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const ok = await verifyDeletedPassword(candidate);
      if (ok) {
        navigation.reset({
          index: 0,
          routes: [{ name: 'DeletedChatsSelector' }],
        });
      } else {
        // Per the spec: an incorrect password sends the user straight to
        // the regular chat list. No retry loop here — the lock is a soft
        // gate, not a brute-force barrier.
        goToChatList();
      }
    } catch {
      goToChatList();
    } finally {
      setSubmitting(false);
    }
  };

  const themeColor = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.placeHolderTextColor;
  const pageBg = isDarkMode ? '#0B141A' : '#F4F6F9';
  const cardBg = isDarkMode ? '#16222C' : '#FFFFFF';
  const inputBg = isDarkMode ? '#0F1A21' : '#F2F4F8';

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <Animated.View style={[styles.inner, { opacity: fadeAnim }]}>
          {/* Glow */}
          <View pointerEvents="none" style={[styles.glow, { backgroundColor: themeColor + '22' }]} />
          <View pointerEvents="none" style={[styles.glow2, { backgroundColor: themeColor + '10' }]} />

          <Animated.View
            style={[
              styles.card,
              { backgroundColor: cardBg, transform: [{ translateX: shakeAnim }] },
            ]}
          >
            <View style={[styles.badge, { backgroundColor: themeColor + '1A' }]}>
              <MaterialCommunityIcons name="lock-outline" size={36} color={themeColor} />
            </View>
            <Text style={[styles.title, { color: primaryText }]}>Locked area</Text>
            <Text style={[styles.body, { color: subText }]}>
              Enter your deleted-chats password to continue. If you'd rather
              skip, you'll be taken straight to your regular chat list.
            </Text>

            <View style={[styles.inputWrap, {
              backgroundColor: inputBg,
              borderColor: error ? '#E5393580' : 'transparent',
            }]}>
              <Ionicons name="key-outline" size={18} color={subText} />
              <TextInput
                value={pwd}
                onChangeText={(t) => { setPwd(t); if (error) setError(''); }}
                placeholder="Password"
                placeholderTextColor={subText}
                secureTextEntry={!showPwd}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                editable={!submitting}
                onSubmitEditing={handleSubmit}
                returnKeyType="done"
                style={[styles.input, { color: primaryText }]}
              />
              <TouchableOpacity
                onPress={() => setShowPwd((s) => !s)}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons
                  name={showPwd ? 'eye-off-outline' : 'eye-outline'}
                  size={20} color={subText}
                />
              </TouchableOpacity>
            </View>

            {!!error && <Text style={styles.errorText}>{error}</Text>}

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={handleSubmit}
              disabled={submitting}
              style={[styles.primaryBtn, {
                backgroundColor: themeColor, opacity: submitting ? 0.7 : 1,
              }]}
            >
              {submitting ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <>
                  <Ionicons name="lock-open-outline" size={18} color="#fff" />
                  <Text style={styles.primaryBtnText}>Unlock</Text>
                </>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              activeOpacity={0.7}
              onPress={goToChatList}
              disabled={submitting}
              style={styles.skipBtn}
            >
              <Text style={[styles.skipText, { color: subText }]}>
                Skip and open chat list
              </Text>
            </TouchableOpacity>
          </Animated.View>
        </Animated.View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  flex: { flex: 1 },
  inner: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    position: 'relative',
  },
  glow: {
    position: 'absolute',
    top: '15%', right: -60,
    width: 240, height: 240, borderRadius: 120,
  },
  glow2: {
    position: 'absolute',
    bottom: '15%', left: -50,
    width: 200, height: 200, borderRadius: 100,
  },
  card: {
    borderRadius: 24,
    padding: 26,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.1,
    shadowOffset: { width: 0, height: 16 },
    shadowRadius: 28,
    elevation: 6,
  },
  badge: {
    width: 76, height: 76, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 18,
  },
  title: {
    fontFamily: 'Roboto-Bold',
    fontSize: 22,
    marginBottom: 8,
  },
  body: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginBottom: 22,
    paddingHorizontal: 6,
  },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 14,
    paddingHorizontal: 14,
    height: 52,
    width: '100%',
    gap: 10,
    borderWidth: 1.5,
  },
  input: {
    flex: 1,
    fontFamily: 'Roboto-Regular',
    fontSize: 15,
    paddingVertical: 0,
  },
  errorText: {
    color: '#E53935',
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 8,
    alignSelf: 'flex-start',
    marginLeft: 4,
  },
  primaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    height: 50,
    borderRadius: 14,
    width: '100%',
    marginTop: 18,
  },
  primaryBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
  skipBtn: {
    marginTop: 14,
    paddingVertical: 8,
  },
  skipText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
  },
});
