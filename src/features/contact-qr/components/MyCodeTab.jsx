/**
 * "My code" tab — the code other people scan to save you as a contact.
 *
 * The code holds only a server token (see utils/qrPayload), so it can be reset
 * from the screen's ⋮ menu, which kills every screenshot of the old one.
 * `captureRef` wraps the avatar + card: it is what the header's share icon
 * sends as an image.
 */
import React from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  ScrollView,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';
import VerifiedBadge from '../../../components/VerifiedBadge';
import { buildContactQrValue } from '../utils/qrPayload';

const { width: SCREEN_W } = Dimensions.get('window');
const QR_SIZE = Math.min(SCREEN_W * 0.52, 220);
const AVATAR = 76;
const RING = 5;
const AVATAR_COLORS = ['#6C5CE7', '#00B894', '#E17055', '#0984E3', '#E84393'];

const initialsOf = (name) =>
  String(name || '').trim().split(/\s+/).map((p) => p.charAt(0).toUpperCase()).join('').slice(0, 2);

export default function MyCodeTab({ qr, profileData, captureRef }) {
  const { theme, isDarkMode } = useTheme();
  const hideContact = Boolean(profileData?.privacySettings?.hideContact);
  const accent = theme.colors.themeColor;
  const pageBg = theme.colors.background;
  const name = profileData?.fullName || 'User';
  const avatarBg = AVATAR_COLORS[(name.charCodeAt(0) || 0) % AVATAR_COLORS.length];

  const renderQrArea = () => {
    if (qr.token) {
      return (
        <QRCode
          value={buildContactQrValue(qr.token)}
          size={QR_SIZE}
          color="#0B141A"
          backgroundColor="#FFFFFF"
          ecl="H"
          logo={require('../../../../assets/icon0.png')}
          logoSize={QR_SIZE * 0.2}
          logoBackgroundColor="#FFFFFF"
          logoMargin={4}
          logoBorderRadius={10}
        />
      );
    }
    if (qr.loading) {
      return (
        <View style={[styles.qrPlaceholder, { width: QR_SIZE, height: QR_SIZE }]}>
          <ActivityIndicator size="large" color={accent} />
        </View>
      );
    }
    return (
      <View style={[styles.qrPlaceholder, { width: QR_SIZE, height: QR_SIZE }]}>
        <MaterialCommunityIcons name="qrcode-remove" size={44} color="#9AA5AB" />
        <Text style={styles.qrErrorText}>{qr.error}</Text>
        <TouchableOpacity onPress={qr.load} style={[styles.retryBtn, { backgroundColor: accent }]} activeOpacity={0.85}>
          <Text style={styles.retryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: pageBg }}
      contentContainerStyle={styles.scroll}
      showsVerticalScrollIndicator={false}
    >
      {/* Captured as the share image — painted with the page background so the
          overlapping avatar ring reads the same in the PNG. The code itself
          always sits on white so it scans in dark mode too. */}
      <View ref={captureRef} collapsable={false} style={[styles.capture, { backgroundColor: pageBg }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: theme.colors.surface,
              borderColor: isDarkMode ? 'transparent' : theme.colors.borderColor,
            },
          ]}
        >
          <View style={styles.nameRow}>
            <Text style={[styles.name, { color: theme.colors.primaryTextColor }]} numberOfLines={1}>
              {name}
            </Text>
            <VerifiedBadge verified={profileData?.isVerified} size={17} />
          </View>
          <Text style={[styles.sub, { color: theme.colors.secondaryTextColor }]} numberOfLines={1}>
            TalksTry contact
          </Text>

          <View style={styles.qrBox}>{renderQrArea()}</View>
        </View>

        <View style={[styles.avatarRing, { backgroundColor: pageBg }]}>
          <View style={[styles.avatar, { backgroundColor: avatarBg }]}>
            {profileData?.profileImage ? (
              <Image source={{ uri: profileData.profileImage }} style={styles.avatarImg} />
            ) : (
              <Text style={styles.avatarText}>{initialsOf(name)}</Text>
            )}
          </View>
        </View>
      </View>

      <Text style={[styles.caption, { color: theme.colors.secondaryTextColor }]}>
        {hideContact
          ? "Your QR code is private. People who scan it in TalksTry can chat with you. Your number is hidden, so they can't save you as a phone contact."
          : 'Your QR code is private. If you share it with someone, they can scan it with their TalksTry camera to add you as a contact.'}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
  },

  capture: { width: '100%', maxWidth: 340, alignItems: 'center', paddingTop: 4 },
  card: {
    width: '100%',
    marginTop: AVATAR / 2 + RING,
    paddingTop: AVATAR / 2 + 16,
    paddingBottom: 26,
    paddingHorizontal: 20,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
  },
  avatarRing: {
    position: 'absolute',
    top: 4,
    width: AVATAR + RING * 2,
    height: AVATAR + RING * 2,
    borderRadius: (AVATAR + RING * 2) / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatar: {
    width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2,
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
  },
  avatarImg: { width: AVATAR, height: AVATAR, borderRadius: AVATAR / 2 },
  avatarText: { color: '#fff', fontFamily: 'Roboto-Bold', fontSize: 26 },

  nameRow: { flexDirection: 'row', alignItems: 'center', maxWidth: '100%' },
  name: { fontFamily: 'Roboto-Medium', fontSize: 20, textTransform: 'capitalize', flexShrink: 1 },
  sub: { fontFamily: 'Roboto-Regular', fontSize: 14, marginTop: 3 },

  qrBox: { marginTop: 20, padding: 12, backgroundColor: '#FFFFFF', borderRadius: 14 },
  qrPlaceholder: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  qrErrorText: {
    fontFamily: 'Roboto-Regular', fontSize: 13, color: '#667781',
    textAlign: 'center', marginTop: 10, lineHeight: 18,
  },
  retryBtn: { marginTop: 14, paddingHorizontal: 22, paddingVertical: 9, borderRadius: 30 },
  retryText: { fontFamily: 'Roboto-SemiBold', fontSize: 14, color: '#fff' },

  caption: {
    fontFamily: 'Roboto-Regular', fontSize: 14.5, lineHeight: 21,
    textAlign: 'center', marginTop: 28, maxWidth: 320,
  },
});
