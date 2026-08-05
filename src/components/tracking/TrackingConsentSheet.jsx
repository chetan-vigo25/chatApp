/**
 * TrackingConsentSheet
 *
 * DPDP consent notice for the admin-controlled Tracking module. Shown as a
 * bottom sheet whenever the server tracking config says enabled with consent
 * still 'pending'. Explains what is collected, who sees it and for how long,
 * then records the decision via socket `tracking:consent` and mirrors it into
 * the Redux tracking slice.
 *
 * Self-gating: reads visibility straight from the `tracking` slice, so it can
 * be mounted once at the app root (App.js, above PrivacyOverlay) with no props.
 */
import React, { useCallback, useState } from 'react';
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useDispatch, useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { emitSocketEvent } from '../../Redux/Services/Socket/socket';
import {
  consentGranted,
  consentDeclined,
} from '../../Redux/Reducer/Tracking/Tracking.reducer';

const BULLETS = [
  {
    icon: 'location-outline',
    text: 'Your location while you are using the app (foreground only — never in the background).',
  },
  {
    icon: 'phone-portrait-outline',
    text: 'Basic device information sent with each update: device model, battery level, network type and timezone.',
  },
  {
    icon: 'eye-outline',
    text: "Visible only to your organization's administrators. A visible indicator is always shown while tracking is active.",
  },
  {
    icon: 'time-outline',
    text: 'Location data is retained for up to 90 days, then deleted.',
  },
];

const TrackingConsentSheet = () => {
  const { theme } = useTheme();
  const { colors, fonts } = theme;
  const dispatch = useDispatch();
  const enabled = useSelector((s) => !!s?.tracking?.enabled);
  const consent = useSelector((s) => s?.tracking?.consent);
  const noticeVersion = useSelector((s) => s?.tracking?.config?.noticeVersion);
  const [submitting, setSubmitting] = useState(false);

  const visible = enabled && consent === 'pending';

  const respond = useCallback(
    (granted) => {
      if (submitting) return;
      setSubmitting(true);
      // Record server-side (versioned notice), mirror locally either way —
      // the server also echoes the result on the next tracking:config push.
      emitSocketEvent('tracking:consent', { granted, noticeVersion }, () => {});
      dispatch(granted ? consentGranted() : consentDeclined());
      setSubmitting(false);
    },
    [submitting, noticeVersion, dispatch],
  );

  if (!visible) return null;

  return (
    <Modal transparent visible animationType="slide" statusBarTranslucent onRequestClose={() => {}}>
      <View style={styles.scrim}>
        <View style={[styles.sheet, { backgroundColor: colors.cardBackground }]}>
          <View style={[styles.grabber, { backgroundColor: colors.borderColor }]} />
          <View style={[styles.iconDisc, { backgroundColor: `${colors.themeColor}1A` }]}>
            <Ionicons name="location" size={26} color={colors.themeColor} />
          </View>
          <Text style={[styles.title, { color: colors.primaryTextColor, fontFamily: fonts.semibold }]}>
            Location tracking enabled
          </Text>
          <Text style={[styles.subtitle, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
            Your organization has enabled work-time location tracking for your
            account. Before anything is shared, we need your consent.
          </Text>
          <ScrollView style={styles.bullets} bounces={false}>
            {BULLETS.map((b) => (
              <View key={b.icon} style={styles.bulletRow}>
                <Ionicons name={b.icon} size={18} color={colors.themeColor} style={styles.bulletIcon} />
                <Text style={[styles.bulletText, { color: colors.primaryTextColor, fontFamily: fonts.regular }]}>
                  {b.text}
                </Text>
              </View>
            ))}
          </ScrollView>
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.agreeBtn, { backgroundColor: colors.themeColor }]}
            onPress={() => respond(true)}
          >
            <Text style={[styles.agreeText, { color: colors.textWhite, fontFamily: fonts.semibold }]}>
              Agree
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.7}
            style={styles.declineBtn}
            onPress={() => respond(false)}
          >
            <Text style={[styles.declineText, { color: colors.secondaryTextColor, fontFamily: fonts.medium }]}>
              Decline
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 22,
    paddingTop: 10,
    paddingBottom: 28,
    alignItems: 'center',
  },
  grabber: {
    width: 40,
    height: 4,
    borderRadius: 2,
    marginBottom: 16,
  },
  iconDisc: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 19,
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    marginBottom: 16,
  },
  bullets: {
    alignSelf: 'stretch',
    maxHeight: 220,
    marginBottom: 20,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  bulletIcon: {
    marginRight: 10,
    marginTop: 1,
  },
  bulletText: {
    flex: 1,
    fontSize: 13.5,
    lineHeight: 19,
  },
  agreeBtn: {
    alignSelf: 'stretch',
    borderRadius: 24,
    paddingVertical: 13,
    alignItems: 'center',
  },
  agreeText: {
    fontSize: 15,
  },
  declineBtn: {
    alignSelf: 'stretch',
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 4,
  },
  declineText: {
    fontSize: 14,
  },
});

export default TrackingConsentSheet;
