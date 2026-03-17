import React, { useState } from 'react';
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
} from 'react-native';
import { REPORT_REASONS } from '../constant/reportReasons';
import { submitReport } from '../services/ReportService';
import { useTheme } from '../contexts/ThemeContext';

const REASON_ICONS = {
  spam: '🚫',
  harassment: '😤',
  abusive_language: '🤬',
  scam: '⚠️',
  inappropriate_content: '🔞',
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

  const [reason, setReason] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Reset everything when modal opens
  React.useEffect(() => {
    if (visible) {
      setReason('');
      setDescription('');
      setError('');
      setLoading(false);
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
        if (onSuccess) onSuccess();
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

  const reportTypeLabel = payload?.reportType === 'message' ? 'Message' : 'User';

  const themeColor = colors.themeColor;

  const dynamicStyles = {
    sheet: {
      backgroundColor: isDarkMode ? colors.cardBackground : '#fff',
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

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={() => { onClose() }}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <TouchableOpacity style={styles.overlayTouchable} activeOpacity={1} onPress={() => { onClose() }} />

        <View style={[styles.sheet, dynamicStyles.sheet]}>
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

          <ScrollView
            style={styles.scrollContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.sectionLabel, dynamicStyles.sectionLabel]}>Select a reason</Text>
            <View style={styles.reasonList}>
              {REPORT_REASONS.map(r => {
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
                      isActive && { fontWeight: '600' },
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
            <TextInput
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
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
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
    fontWeight: '700',
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
    fontWeight: '600',
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
    fontWeight: '600',
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
    fontWeight: '500',
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
    fontWeight: 'bold',
  },
  input: {
    borderWidth: 1.5,
    borderRadius: 12,
    padding: 14,
    fontSize: 14,
    minHeight: 80,
    marginBottom: 14,
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
    fontWeight: '600',
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
    fontWeight: '700',
    fontSize: 15,
  },
});

export default ReportBottomSheet;
