import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  Modal,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Alert,
  useWindowDimensions,
} from 'react-native';
import { REPORT_REASONS, REPORT_REASONS_BY_TYPE, REPORT_TYPE_LABELS } from '../constant/reportReasons';
import { submitReport } from '../services/ReportService';
import { useTheme } from '../contexts/ThemeContext';
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useKeyboardState } from 'react-native-keyboard-controller';
import AppSheet, { USE_GORHOM } from './AppSheet';

const REASON_ICONS = {
  spam: '🚫',
  harassment: '😤',
  abuse: '🤬',
  abusive_language: '🤬',
  scam: '⚠️',
  violence: '💢',
  adult_content: '🔞',
  inappropriate_content: '🔞',
  fake_information: '📰',
  fake_news: '📰',
  fake_account: '🪪',
  fake_profile: '🪪',
  impersonation: '🎭',
  hate_speech: '🗯️',
  threats: '🔪',
  nudity: '🔞',
  copyright: '©️',
  illegal_content: '🚔',
  other: '📝',
};

export const ReportBottomSheet = ({
  visible,
  onClose,
  payload,
  onSuccess,
  analytics,
}) => {
  const { theme, isDarkMode } = useTheme();
  const colors = theme.colors;
  // Inside the sheet the scroll view gets no height from its parent (gorhom's
  // content container is not bounded), so it is capped explicitly: the sheet is
  // 85% of the window and the handle + header + divider + bottom padding take
  // the rest. Beyond that it scrolls — same limit the old Modal's maxHeight set.
  const { height: winH } = useWindowDimensions();
  const sheetH = Math.round(winH * 0.85);
  // The app draws edge-to-edge (keyboard-controller), so the window does not
  // resize for the keyboard and the sheet cannot rise past its top snap. Shrink
  // the scroll area by the keyboard height and scroll the details box into view.
  const kbH = useKeyboardState((st) => (st.isVisible ? st.height : 0));
  const scrollRef = useRef(null);
  useEffect(() => {
    if (kbH > 0) setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 60);
  }, [kbH]);
  const scrollMaxH = sheetH - 160 - kbH;

  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [blockUser, setBlockUser] = useState(false);
  const [deleteChat, setDeleteChat] = useState(false);

  const reportType = payload?.reportType || 'user';
  const reasons = REPORT_REASONS_BY_TYPE[reportType] || REPORT_REASONS;

  // Reset everything when modal opens
  React.useEffect(() => {
    if (visible) {
      setReason('');
      setDescription('');
      setError('');
      setLoading(false);
      setBlockUser(false);
      setDeleteChat(false);
      if (analytics?.report_opened) analytics.report_opened();
    }
  }, [visible]);

  const handleSubmit = async () => {
    setError('');
    if (!reason) {
      setError('Please select a reason.');
      return;
    }
    setLoading(true);
    try {
      const res = await submitReport({
        ...payload,
        reason,
        description,
      });
      setLoading(false);
      if (res.success) {
        if (analytics?.report_submitted) analytics.report_submitted();
        if (onSuccess) onSuccess({ blockUser, deleteChat });
        onClose();
        setTimeout(() => {
          Alert.alert(
            'Report Submitted',
            'Thank you for helping us keep the community safe. We will review your report shortly.',
            [{ text: 'OK' }],
          );
        }, 300);
      } else {
        setError(res.message || 'Failed to submit report.');
        if (analytics?.report_failed) analytics.report_failed();
      }
    } catch (err) {
      setLoading(false);
      setError('Network error. Please try again.');
      if (analytics?.report_failed) analytics.report_failed();
    }
  };

  const reportTypeLabel = REPORT_TYPE_LABELS[reportType] || 'User';

  const themeColor = colors.themeColor;

  const dynamicStyles = {
    sheet: {
      backgroundColor: colors.menuSurface,
    },
    handleBar: {
      backgroundColor: isDarkMode ? '#3A4750' : '#DEDEDE',
    },
    headerIconWrap: {
      backgroundColor: isDarkMode ? '#2C2210' : '#FFF3E0',
    },
    title: {
      color: colors.primaryTextColor,
    },
    subtitle: {
      color: isDarkMode ? '#9BA4AB' : '#888',
    },
    closeIconBtn: {
      backgroundColor: isDarkMode ? colors.menuBackground : '#F0F0F0',
    },
    closeIconText: {
      color: isDarkMode ? '#9BA4AB' : '#666',
    },
    divider: {
      backgroundColor: isDarkMode ? '#2C3840' : '#F0F0F0',
    },
    sectionLabel: {
      color: isDarkMode ? '#9BA4AB' : '#888',
    },
    reasonBtn: {
      backgroundColor: isDarkMode ? colors.menuBackground : '#F7F7F8',
      borderColor: isDarkMode ? '#2C3840' : '#F0F0F0',
    },
    reasonBtnActive: {
      backgroundColor: isDarkMode ? '#0D2A3D' : '#E6F7F5',
      borderColor: themeColor,
    },
    reasonText: {
      color: colors.primaryTextColor,
    },
    reasonTextActive: {
      color: themeColor,
    },
    input: {
      backgroundColor: isDarkMode ? colors.menuBackground : '#FAFAFA',
      borderColor: isDarkMode ? '#2C3840' : '#E8E8E8',
      color: colors.primaryTextColor,
    },
    errorContainer: {
      backgroundColor: isDarkMode ? '#2D1A1A' : '#FFF5F5',
      borderColor: isDarkMode ? '#4A2020' : '#FFE0E0',
    },
    cancelBtn: {
      backgroundColor: isDarkMode ? colors.menuBackground : '#F2F2F3',
      borderColor: isDarkMode ? '#2C3840' : '#E0E0E0',
    },
    cancelBtnText: {
      color: isDarkMode ? '#9BA4AB' : '#555',
    },
    submitBtn: {
      backgroundColor: themeColor,
      shadowColor: themeColor,
    },
  };

  // Same content for the gorhom sheet and the legacy Modal; only the scroll view
  // and the text input differ (inside the sheet they must be gorhom's own so the
  // keyboard, scrolling and sheet drag cooperate).
  const renderInner = (ScrollComp, InputComp) => (
    <>
  <View style={[styles.handleBar, dynamicStyles.handleBar]} />

  {/* Header */}
  <View style={styles.header}>
    <View style={styles.headerLeft}>
      <View style={[styles.headerIconWrap, dynamicStyles.headerIconWrap]}>
        <Text style={styles.headerIcon}>🛡️</Text>
      </View>
      <View>
        <Text style={[styles.title, dynamicStyles.title]}>Report {reportTypeLabel}</Text>
        <Text style={[styles.subtitle, dynamicStyles.subtitle]}>Help us keep the community safe</Text>
      </View>
    </View>
    <TouchableOpacity
      style={[styles.closeIconBtn, dynamicStyles.closeIconBtn]}
      onPress={() => { onClose() }}
      disabled={loading}
      hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
    >
      <Text style={[styles.closeIconText, dynamicStyles.closeIconText]}>✕</Text>
    </TouchableOpacity>
  </View>

  <View style={[styles.divider, dynamicStyles.divider]} />

  <ScrollComp
    ref={ScrollComp === ScrollView ? undefined : scrollRef}
    style={ScrollComp === ScrollView ? styles.scrollContent : { maxHeight: scrollMaxH }}
    showsVerticalScrollIndicator={false}
    bounces={false}
    keyboardShouldPersistTaps="handled"
  >
    <Text style={[styles.sectionLabel, dynamicStyles.sectionLabel]}>Select a reason</Text>
    <View style={styles.reasonList}>
      {reasons.map(r => {
        const isActive = reason === r.key;
        return (
          <TouchableOpacity
            key={r.key}
            style={[
              styles.reasonBtn,
              dynamicStyles.reasonBtn,
              isActive && dynamicStyles.reasonBtnActive,
            ]}
            onPress={() => setReason(r.key)}
            disabled={loading}
            activeOpacity={0.7}
          >
            <Text style={styles.reasonIcon}>{REASON_ICONS[r.key] || '📝'}</Text>
            <Text style={[
              styles.reasonText,
              dynamicStyles.reasonText,
              isActive && dynamicStyles.reasonTextActive,
              isActive && { fontFamily: 'Roboto-SemiBold' },
            ]}>
              {r.label}
            </Text>
            {isActive && (
              <View style={[styles.checkMark, { backgroundColor: themeColor }]}>
                <Text style={styles.checkMarkText}>✓</Text>
              </View>
            )}
          </TouchableOpacity>
        );
      })}
    </View>

    <Text style={[styles.sectionLabel, dynamicStyles.sectionLabel]}>Additional details (optional)</Text>
    <InputComp
      keyboardAppearance={isDarkMode ? 'dark' : 'light'}
      style={[styles.input, dynamicStyles.input]}
      value={description}
      onChangeText={setDescription}
      placeholder="Tell us more about what happened..."
      placeholderTextColor={colors.placeHolderTextColor}
      editable={!loading}
      multiline
      numberOfLines={3}
      textAlignVertical="top"
    />

    {(payload?.canBlock || payload?.canDeleteChat) ? (
      <View style={styles.optionList}>
        {payload?.canBlock ? (
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => setBlockUser(v => !v)}
            disabled={loading}
            activeOpacity={0.7}
          >
            <View style={[
              styles.optionCheckbox,
              { borderColor: blockUser ? themeColor : (isDarkMode ? '#3A4750' : '#CCC') },
              blockUser && { backgroundColor: themeColor },
            ]}>
              {blockUser ? <Text style={styles.optionCheckMark}>✓</Text> : null}
            </View>
            <Text style={[styles.optionText, dynamicStyles.reasonText]}>Block user after report</Text>
          </TouchableOpacity>
        ) : null}
        {payload?.canDeleteChat ? (
          <TouchableOpacity
            style={styles.optionRow}
            onPress={() => setDeleteChat(v => !v)}
            disabled={loading}
            activeOpacity={0.7}
          >
            <View style={[
              styles.optionCheckbox,
              { borderColor: deleteChat ? themeColor : (isDarkMode ? '#3A4750' : '#CCC') },
              deleteChat && { backgroundColor: themeColor },
            ]}>
              {deleteChat ? <Text style={styles.optionCheckMark}>✓</Text> : null}
            </View>
            <Text style={[styles.optionText, dynamicStyles.reasonText]}>Delete chat after report</Text>
          </TouchableOpacity>
        ) : null}
      </View>
    ) : null}

    {error ? (
      <View style={[styles.errorContainer, dynamicStyles.errorContainer]}>
        <Text style={styles.errorIcon}>⚠</Text>
        <Text style={styles.errorText}>{error}</Text>
      </View>
    ) : null}

    <View style={styles.buttonRow}>
      <TouchableOpacity
        style={[styles.cancelBtn, dynamicStyles.cancelBtn]}
        onPress={() => { onClose() }}
        disabled={loading}
        activeOpacity={0.7}
      >
        <Text style={[styles.cancelBtnText, dynamicStyles.cancelBtnText]}>Cancel</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[
          styles.submitBtn,
          dynamicStyles.submitBtn,
          (!reason || loading) && styles.submitBtnDisabled,
        ]}
        onPress={handleSubmit}
        disabled={loading || !reason}
        activeOpacity={0.7}
      >
        {loading ? (
          <ActivityIndicator color="#fff" size="small" />
        ) : (
          <Text style={styles.submitBtnText}>Submit Report</Text>
        )}
      </TouchableOpacity>
    </View>
  </ScrollComp>
    </>
  );

  if (USE_GORHOM) {
    return (
      <AppSheet
        visible={visible}
        onClose={onClose}
        snapPoints={[sheetH]}
        keyboardAware
        backdropOpacity={0.5}
        backgroundColor={dynamicStyles.sheet.backgroundColor}
      >
        <View style={styles.gorhomSheet}>
          {renderInner(BottomSheetScrollView, BottomSheetTextInput)}
        </View>
      </AppSheet>
    );
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => { onClose() }}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity style={styles.overlayTouchable} activeOpacity={1} onPress={() => { onClose() }} />

        <View style={[styles.sheet, dynamicStyles.sheet]}>
          {renderInner(ScrollView, TextInput)}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  gorhomSheet: {
    flex: 1,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  overlayTouchable: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    maxHeight: '85%',
  },
  handleBar: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  headerIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  headerIcon: {
    fontSize: 20,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Roboto-Bold',
  },
  subtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  closeIconBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeIconText: {
    fontSize: 14,
    fontFamily: 'Roboto-SemiBold',
  },
  divider: {
    height: 1,
    marginBottom: 16,
  },
  scrollContent: {
    flexGrow: 0,
  },
  sectionLabel: {
    fontSize: 14,
    fontFamily: 'Roboto-SemiBold',
    marginBottom: 10,
  },
  reasonList: {
    marginBottom: 18,
  },
  reasonBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
    borderWidth: 1.5,
  },
  reasonIcon: {
    fontSize: 18,
    marginRight: 10,
  },
  reasonText: {
    fontSize: 14,
    fontFamily: 'Roboto-Medium',
    flex: 1,
  },
  checkMark: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkMarkText: {
    color: '#fff',
    fontSize: 12,
    fontFamily: 'Roboto-Bold',
  },
  input: {
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    minHeight: 80,
    marginBottom: 14,
  },
  optionList: {
    marginBottom: 14,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  optionCheckbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  optionCheckMark: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Roboto-Bold',
  },
  optionText: {
    fontSize: 14,
    fontFamily: 'Roboto-Medium',
    flex: 1,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    padding: 10,
    marginBottom: 14,
    borderWidth: 1,
  },
  errorIcon: {
    fontSize: 16,
    marginRight: 8,
  },
  errorText: {
    color: '#D32F2F',
    fontSize: 13,
    flex: 1,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 4,
    marginBottom: 30,
  },
  cancelBtn: {
    flex: 1,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  cancelBtnText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
  submitBtn: {
    flex: 1.5,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  submitBtnDisabled: {
    opacity: 0.5,
    shadowOpacity: 0,
    elevation: 0,
  },
  submitBtnText: {
    color: '#fff',
    fontFamily: 'Roboto-Bold',
    fontSize: 15,
  },
});

export default ReportBottomSheet;