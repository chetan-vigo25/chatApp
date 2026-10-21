// In-app viewer for a business chat's document (PDF / Office files) — iOS only.
//
// PDF VIEWING DECISION (docs/BUSINESS_CHAT_README.md §3.5), no new dependency:
//   iOS     → this modal: react-native-webview on the cached file:// copy
//             (WKWebView renders PDF and Office documents).
//   Android → WebView cannot render PDFs, so the cached file is handed to the
//             OS viewer with expo-intent-launcher (ACTION_VIEW). That leaves the
//             app; an in-app Android renderer (react-native-pdf) is a new native
//             dependency and needs approval first. Google-Docs viewer URLs are
//             NOT an option — they send the customer's document to a third party.
// The viewer offers nothing to save, share or forward (read-only chat).
import React from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export default function BusinessDocumentViewer({ visible, uri, title, onClose }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn} hitSlop={styles.hitSlop}>
            <Ionicons name="close" size={24} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>{title || 'Document'}</Text>
        </View>
        {uri ? (
          <WebView
            source={{ uri }}
            originWhitelist={['*']}
            allowingReadAccessToURL={uri}
            allowFileAccess
            style={styles.web}
            startInLoadingState
            renderLoading={() => (
              <View style={styles.loading}>
                <ActivityIndicator color="#fff" />
              </View>
            )}
          />
        ) : (
          <View style={styles.loading}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#111' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
  },
  closeBtn: { padding: 6 },
  hitSlop: { top: 10, bottom: 10, left: 10, right: 10 },
  title: {
    flex: 1,
    marginLeft: 8,
    color: '#fff',
    fontSize: 16,
    fontFamily: 'Roboto-Medium',
  },
  web: { flex: 1, backgroundColor: '#fff' },
  loading: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
});
