import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable } from 'react-native';

/**
 * Shown when a status-reply quote is tapped but the status can't be opened.
 * It used to open the StatusViewer on a dead presigned URL → a black screen
 * that auto-closed. Now a plain alert-style dialog (WhatsApp's "Couldn't
 * download" look): title, one line, OK. `expired` false = the fetch failed
 * (offline), which must not claim the status expired.
 */
export default function StatusUnavailableModal({
  visible,
  onClose,
  expired = true,
  // Overrides — the same dialog doubles as chat media's "Couldn't download".
  title = null,
  message = null,
  theme,
  isDarkMode = false,
}) {
  const bg = theme?.colors?.menuSurface || (isDarkMode ? '#202323' : '#ffffff');
  const fg = theme?.colors?.primaryTextColor || (isDarkMode ? '#e9edef' : '#111b21');
  const sub = theme?.colors?.secondaryTextColor || (isDarkMode ? '#8696a0' : '#667781');
  const accent = isDarkMode ? '#e9edef' : (theme?.colors?.themeColor || '#03b0a2');

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.scrim} onPress={onClose}>
        <Pressable style={[styles.card, { backgroundColor: bg }]} onPress={() => {}}>
          <Text style={[styles.title, { color: fg }]}>
            {title || (expired ? 'Status Expired' : "Couldn't open status")}
          </Text>
          <Text style={[styles.body, { color: sub }]}>
            {message || (expired
              ? 'This status is no longer available. Status updates disappear after 24 hours.'
              : 'Please check your connection and try again.')}
          </Text>
          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}>
              <Text style={[styles.ok, { color: accent }]}>OK</Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  card: { width: '100%', maxWidth: 360, borderRadius: 28, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 18 },
  title: { fontFamily: 'Roboto-Regular', fontSize: 24, marginBottom: 14 },
  body: { fontFamily: 'Roboto-Regular', fontSize: 15, lineHeight: 22 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 28 },
  ok: { fontFamily: 'Roboto-Medium', fontSize: 15, letterSpacing: 0.3 },
});
