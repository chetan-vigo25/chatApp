/**
 * MediaCaptionBar — the WhatsApp-style send row pinned under AttachmentSheet's
 * grid once anything is picked:
 *
 *   [ latest pick ]  ( Add a caption...          (1) )  ( ➤ n )
 *
 * Deliberately NO edit / crop affordance on the thumbnail — it is a preview
 * only.
 *
 * ── Rules this file holds to ──
 *  • The caption text lives HERE, not in AttachmentSheet. Held in the sheet,
 *    every keystroke would re-render it and hand the FlatList a fresh
 *    contentContainerStyle / ListFooterComponent — reconciling the whole
 *    visible grid per character typed.
 *  • The screen is never resized by the keyboard (react-native-keyboard-
 *    controller owns it; ChatScreen pads by the same value), so the bar rides
 *    above the keyboard by TRANSFORM only — the sheet's rule, nothing
 *    layout-affecting is animated.
 *  • View once and caption are mutually exclusive. sendMedia drops a caption on
 *    a view-once send by contract, so the field is locked rather than letting
 *    the user type text that silently vanishes. The typed caption is kept, so
 *    toggling view once back off restores it.
 */
import React, { useCallback, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import Reanimated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

function MediaCaptionBar({
  store,
  assetsById,
  viewOnce,
  onToggleViewOnce,
  onSend,
  onFocus,
  sending,
  colors,
  fonts,
  accent,
  isDarkMode,
}) {
  // getIds() is replaced, never mutated, so it is a valid snapshot.
  const ids = useSyncExternalStore(store.subscribe, store.getIds);
  const count = ids.length;
  const lastId = count ? ids[count - 1] : null;
  const lastUri = lastId ? assetsById.get(lastId)?.uri : null;

  const [caption, setCaption] = useState('');

  // Same formula as ChatScreen's rootKeyboardStyle: the container is already
  // inset by RootNavigator's SafeAreaView, the keyboard height is not.
  const { height: kbHeight } = useReanimatedKeyboardAnimation();
  const { bottom: bottomInset } = useSafeAreaInsets();
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, Math.abs(kbHeight.value) - bottomInset) }],
  }), [bottomInset]);

  const handleSend = useCallback(() => {
    onSend(viewOnce ? '' : caption.trim());
  }, [onSend, viewOnce, caption]);

  if (!count) return null;

  return (
    <Reanimated.View
      style={[
        styles.bar,
        { backgroundColor: colors.cardBackground, borderTopColor: colors.divider },
        liftStyle,
      ]}
    >
      <Image
        source={lastUri}
        style={[styles.thumb, { backgroundColor: colors.surface }]}
        contentFit="cover"
        cachePolicy="memory-disk"
        transition={0}
        recyclingKey={lastId}
        accessibilityLabel={`${count} selected`}
      />

      <View style={[styles.pill, { backgroundColor: colors.surface }]}>
        <TextInput
          value={viewOnce ? '' : caption}
          onChangeText={setCaption}
          onFocus={onFocus}
          editable={!viewOnce}
          placeholder={viewOnce ? 'No caption on view once' : 'Add a caption...'}
          placeholderTextColor={colors.secondaryTextColor}
          keyboardAppearance={isDarkMode ? 'dark' : 'light'}
          multiline
          textAlignVertical="center"
          accessibilityLabel="Media caption input"
          style={[styles.input, { color: colors.primaryTextColor, fontFamily: fonts.regular }]}
        />

        <TouchableOpacity
          onPress={onToggleViewOnce}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={[styles.viewOnce, {
            backgroundColor: viewOnce ? accent : 'transparent',
            borderColor: viewOnce ? accent : colors.secondaryTextColor,
          }]}
          accessibilityRole="button"
          accessibilityState={{ selected: viewOnce }}
          accessibilityLabel={viewOnce ? 'View once on' : 'View once'}
        >
          <Text style={[styles.viewOnceText, {
            color: viewOnce ? '#fff' : colors.secondaryTextColor,
            fontFamily: fonts.bold,
          }]}>
            1
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[styles.send, { backgroundColor: accent }]}
        onPress={handleSend}
        disabled={sending}
        accessibilityRole="button"
        accessibilityLabel={`Send ${count} item${count === 1 ? '' : 's'}`}
      >
        {sending ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Ionicons name="send" size={20} color="#fff" style={styles.sendGlyph} />
        )}
        <View style={[styles.count, { backgroundColor: colors.cardBackground, borderColor: accent }]}>
          <Text style={[styles.countText, { color: accent, fontFamily: fonts.bold }]}>{count}</Text>
        </View>
      </TouchableOpacity>
    </Reanimated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 48, height: 48, borderRadius: 10 },
  pill: {
    flex: 1,
    minHeight: 48,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 9,
    gap: 8,
  },
  input: { flex: 1, fontSize: 16, maxHeight: 96, paddingVertical: 8 },
  viewOnce: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewOnceText: { fontSize: 12 },
  send: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendGlyph: { marginLeft: 3 },
  count: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: { fontSize: 11 },
});

export default React.memo(MediaCaptionBar);
