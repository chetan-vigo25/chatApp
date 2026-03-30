/**
 * Bottom sheet shown after a QR code is scanned.
 * Displays the server URL for user verification and confirm/cancel actions.
 */
import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Modal,
} from 'react-native';
import { FontAwesome6, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../../contexts/ThemeContext';

/**
 * @param {Object} props
 * @param {boolean} props.visible
 * @param {{ sessionId: string, serverUrl: string }} props.qrData
 * @param {boolean} props.isLinking - Show loading state
 * @param {boolean} props.isTrustedUrl - Whether the serverUrl matches expected backend
 * @param {() => void} props.onConfirm
 * @param {() => void} props.onCancel
 */
export default function ScanConfirmSheet({
  visible,
  qrData,
  isLinking,
  isTrustedUrl,
  onConfirm,
  onCancel,
}) {
  const { theme } = useTheme();

  if (!visible || !qrData) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onCancel}
    >
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: theme.colors.cardBackground }]}>
          {/* Header */}
          <View style={styles.handle} />

          <Text style={[styles.title, { color: theme.colors.primaryTextColor }]}>
            Link this device?
          </Text>

          <Text style={[styles.description, { color: theme.colors.placeHolderTextColor }]}>
            You scanned a QR code from a web browser. Confirm to link it to your account.
          </Text>

          {/* Server URL display (only if serverUrl exists) */}
          {qrData.serverUrl ? (
            <View style={[styles.urlBox, { backgroundColor: theme.colors.menuBackground, borderColor: theme.colors.borderColor }]}>
              <MaterialIcons
                name={isTrustedUrl ? 'verified' : 'warning'}
                size={18}
                color={isTrustedUrl ? '#25D366' : '#FFA000'}
              />
              <View style={styles.urlTextContainer}>
                <Text style={[styles.urlLabel, { color: theme.colors.placeHolderTextColor }]}>
                  Server
                </Text>
                <Text
                  style={[styles.urlValue, { color: theme.colors.primaryTextColor }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {qrData.serverUrl}
                </Text>
              </View>
            </View>
          ) : null}

          {qrData.serverUrl && !isTrustedUrl ? (
            <View style={styles.warningRow}>
              <MaterialIcons name="warning" size={14} color="#FFA000" />
              <Text style={styles.warningText}>
                This server URL doesn't match the expected backend. Proceed with caution.
              </Text>
            </View>
          ) : null}

          {/* Session ID (truncated) */}
          <View style={[styles.infoRow, { borderColor: theme.colors.borderColor }]}>
            <FontAwesome6 name="fingerprint" size={14} color={theme.colors.placeHolderTextColor} />
            <Text style={[styles.infoLabel, { color: theme.colors.placeHolderTextColor }]}>
              Session
            </Text>
            <Text
              style={[styles.infoValue, { color: theme.colors.primaryTextColor }]}
              numberOfLines={1}
            >
              {qrData.sessionId.substring(0, 8)}...{qrData.sessionId.slice(-4)}
            </Text>
          </View>

          {/* Buttons */}
          <View style={styles.buttons}>
            <TouchableOpacity
              onPress={onCancel}
              style={[styles.cancelBtn, { borderColor: theme.colors.borderColor }]}
              disabled={isLinking}
              activeOpacity={0.7}
            >
              <Text style={[styles.cancelBtnText, { color: theme.colors.primaryTextColor }]}>
                Cancel
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              onPress={() => {
                if (!isLinking && onConfirm) {
                  onConfirm();
                }
              }}
              style={[styles.confirmBtn, { backgroundColor: isLinking ? theme.colors.placeHolderTextColor : theme.colors.themeColor }]}
              activeOpacity={0.7}
            >
              {isLinking ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.confirmBtnText}>Link Device</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 24,
    paddingBottom: 36,
    paddingTop: 12,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#ccc',
    alignSelf: 'center',
    marginBottom: 16,
  },
  title: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 20,
    marginBottom: 8,
  },
  description: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
  },
  urlBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    marginBottom: 8,
  },
  urlTextContainer: {
    flex: 1,
  },
  urlLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11,
    marginBottom: 2,
  },
  urlValue: {
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
  },
  warningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 12,
    paddingHorizontal: 4,
  },
  warningText: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    color: '#FFA000',
    flex: 1,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderTopWidth: 1,
    marginTop: 8,
  },
  infoLabel: {
    fontFamily: 'Roboto-Regular',
    fontSize: 13,
    width: 60,
  },
  infoValue: {
    fontFamily: 'Roboto-Medium',
    fontSize: 13,
    flex: 1,
  },
  buttons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 24,
  },
  cancelBtn: {
    flex: 1,
    height: 48,
    borderRadius: 40,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
  },
  confirmBtn: {
    flex: 1,
    height: 48,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmBtnText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    color: '#fff',
  },
});