/**
 * TrackingIndicator
 *
 * Small persistent pill shown whenever admin-controlled location tracking is
 * active (enabled + consent granted). Mounted at the app root ABOVE the
 * PrivacyOverlay so the tracked user can ALWAYS see that tracking is on —
 * including under app-lock (transparency requirement, design §S5).
 *
 * Tapping the pill opens a self-status modal fed by `tracking:self:request`:
 * who enabled it / since when / tracked types / retention / consent state.
 */
import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSelector } from 'react-redux';
import { useTheme } from '../../contexts/ThemeContext';
import { emitSocketEvent } from '../../Redux/Services/Socket/socket';

const formatSince = (since) => {
  if (!since) return '—';
  try {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString();
  } catch {
    return '—';
  }
};

const TrackingIndicator = () => {
  const { theme } = useTheme();
  const { colors, fonts } = theme;
  const insets = useSafeAreaInsets();
  const visible = useSelector((s) => !!s?.tracking?.indicatorVisible);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState(null);

  const openStatus = useCallback(() => {
    setModalOpen(true);
    setLoading(true);
    setStatus(null);
    const sent = emitSocketEvent('tracking:self:request', {}, (resp) => {
      setLoading(false);
      if (resp?.ok || resp?.status === true) {
        setStatus(resp?.status && typeof resp.status === 'object' ? resp.status : resp?.data?.status || resp?.data || null);
      }
    });
    if (!sent) setLoading(false);
  }, []);

  if (!visible) return null;

  const rows = status
    ? [
        ['Status', status.status || (status.enabled ? 'active' : 'inactive')],
        ['Tracking', (status.trackingTypes || []).join(', ') || 'location'],
        ['Since', formatSince(status.since)],
        ['Consent', status.consent || 'granted'],
        ['Data retained for', status.retentionDays ? `${status.retentionDays} days` : '90 days'],
      ]
    : [];

  return (
    <>
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={openStatus}
        style={[
          styles.pill,
          { top: insets.top + 6, backgroundColor: colors.themeColor },
        ]}
      >
        <View style={styles.dot} />
        <Text style={[styles.pillText, { color: colors.textWhite, fontFamily: fonts.medium }]}>
          Location tracking active
        </Text>
      </TouchableOpacity>

      <Modal
        transparent
        visible={modalOpen}
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setModalOpen(false)}
      >
        <TouchableOpacity
          style={styles.scrim}
          activeOpacity={1}
          onPress={() => setModalOpen(false)}
        >
          <TouchableOpacity
            activeOpacity={1}
            style={[styles.card, { backgroundColor: colors.cardBackground }]}
          >
            <View style={styles.cardHeader}>
              <Ionicons name="location" size={20} color={colors.themeColor} />
              <Text style={[styles.cardTitle, { color: colors.primaryTextColor, fontFamily: fonts.semibold }]}>
                Tracking status
              </Text>
            </View>
            <Text style={[styles.cardIntro, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
              Your organization has enabled work-time location tracking for your
              account. Location is collected only while you use the app.
            </Text>
            {loading ? (
              <ActivityIndicator color={colors.themeColor} style={styles.loader} />
            ) : (
              rows.map(([label, value]) => (
                <View key={label} style={[styles.row, { borderBottomColor: colors.borderColor }]}>
                  <Text style={[styles.rowLabel, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                    {label}
                  </Text>
                  <Text style={[styles.rowValue, { color: colors.primaryTextColor, fontFamily: fonts.medium }]}>
                    {String(value)}
                  </Text>
                </View>
              ))
            )}
            {!loading && !status ? (
              <Text style={[styles.cardIntro, { color: colors.secondaryTextColor, fontFamily: fonts.regular }]}>
                Status unavailable right now — check again when you are online.
              </Text>
            ) : null}
            <TouchableOpacity
              activeOpacity={0.85}
              style={[styles.closeBtn, { backgroundColor: colors.themeColor }]}
              onPress={() => setModalOpen(false)}
            >
              <Text style={[styles.closeText, { color: colors.textWhite, fontFamily: fonts.semibold }]}>
                Close
              </Text>
            </TouchableOpacity>
          </TouchableOpacity>
        </TouchableOpacity>
      </Modal>
    </>
  );
};

const styles = StyleSheet.create({
  pill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    zIndex: 9999,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#ffffff',
    marginRight: 7,
  },
  pillText: {
    fontSize: 12.5,
  },
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  card: {
    borderRadius: 18,
    padding: 20,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  cardTitle: {
    fontSize: 17,
    marginLeft: 8,
  },
  cardIntro: {
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  loader: {
    marginVertical: 20,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: {
    fontSize: 13,
  },
  rowValue: {
    fontSize: 13,
    maxWidth: '60%',
    textAlign: 'right',
  },
  closeBtn: {
    marginTop: 16,
    borderRadius: 22,
    paddingVertical: 11,
    alignItems: 'center',
  },
  closeText: {
    fontSize: 14,
  },
});

export default TrackingIndicator;
