import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';
import { resetToLogin } from '../Redux/Services/navigationService';

// Dedicated screen the app routes to when the server reports an account-state
// denial (SM2): blocked / inactive / deleted. Distinct from the normal Login so
// the user understands WHY they were signed out instead of seeing a bare login
// form. Reached via resetToAccountStatus() after the local session is wiped.
const STATE_COPY = {
  blocked: {
    icon: 'block',
    title: 'Account blocked',
    body: 'Your account has been blocked by an administrator. Please contact support if you believe this is a mistake.',
  },
  inactive: {
    icon: 'pause-circle-outline',
    title: 'Account deactivated',
    body: 'Your account has been deactivated. Please contact support to reactivate it.',
  },
  deleted: {
    icon: 'delete-outline',
    title: 'Account no longer exists',
    body: 'This account has been deleted. If this was a mistake, contact support to recover it within 30 days.',
  },
};

export default function AccountStatus({ route }) {
  const { theme } = useTheme();
  const state = route?.params?.state || 'blocked';
  const serverMessage = route?.params?.message;
  const copy = STATE_COPY[state] || STATE_COPY.blocked;

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <MaterialIcons name={copy.icon} size={96} color={theme.colors.primary || '#03b0a2'} />
      <Text style={[styles.title, { color: theme.colors.text }]}>{copy.title}</Text>
      <Text style={[styles.body, { color: theme.colors.muted || 'gray' }]}>
        {serverMessage || copy.body}
      </Text>
      <TouchableOpacity
        style={[styles.button, { backgroundColor: theme.colors.primary || '#03b0a2' }]}
        onPress={() => resetToLogin()}
      >
        <Text style={styles.buttonText}>Back to login</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 22,
    fontFamily: 'Roboto-Bold',
    marginTop: 24,
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    fontFamily: 'Roboto-Regular',
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 32,
  },
  button: {
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Roboto-Medium',
  },
});
