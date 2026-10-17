// AppSheet — one gesture bottom sheet (@gorhom/bottom-sheet) for the app's
// Modal-style sheets: drag down to dismiss, backdrop tap closes, Android back
// closes, theme-aware surface. Used by ReactionDetailSheet, the full emoji
// picker and ReportBottomSheet.
//
// It is NOT a <Modal>: it renders as an in-screen overlay (same reason
// AttachmentSheet is not a Modal — a Modal's own Android window inherits neither
// adjustResize nor the gesture-handler root). It brings its own
// GestureHandlerRootView, so it works on screens that have none.
//
// ROLLBACK: set USE_GORHOM = false and every sheet that uses AppSheet renders
// its previous <Modal> markup instead (JS reload only; the package can stay).
//
// NOT used for: AttachmentSheet (custom two-snap sheet, tuned for Android) and
// MenuPopover (the long-press action card is an anchored popover, not a sheet).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import BottomSheet, { BottomSheetBackdrop } from '@gorhom/bottom-sheet';
import { useTheme } from '../contexts/ThemeContext';

export const USE_GORHOM = true;

const RADIUS = 20;

export default function AppSheet({
  visible,
  onClose,
  snapPoints,
  backgroundColor,
  backdropOpacity = 0.45,
  keyboardAware = false,
  children,
}) {
  const { theme } = useTheme();
  const sheetRef = useRef(null);
  // Stays mounted through the close animation, after the host flips `visible`.
  const [mounted, setMounted] = useState(!!visible);
  const visibleRef = useRef(!!visible);
  visibleRef.current = !!visible;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (visible) setMounted(true);
    else sheetRef.current?.close();
  }, [visible]);

  // Android back closes the sheet (not the screen behind it).
  useEffect(() => {
    if (!visible) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onCloseRef.current?.();
      return true;
    });
    return () => sub.remove();
  }, [visible]);

  // Fires when the sheet has finished closing (drag, backdrop, or host-driven).
  const handleClose = useCallback(() => {
    setMounted(false);
    // Only tell the host when the USER closed it; a host-driven close already
    // flipped `visible` itself.
    if (visibleRef.current) onCloseRef.current?.();
  }, []);

  const renderBackdrop = useCallback((props) => (
    <BottomSheetBackdrop
      {...props}
      appearsOnIndex={0}
      disappearsOnIndex={-1}
      opacity={backdropOpacity}
      pressBehavior="close"
    />
  ), [backdropOpacity]);

  if (!mounted) return null;

  const surface = backgroundColor || theme.colors.menuSurface;
  return (
    <GestureHandlerRootView style={styles.root} pointerEvents="box-none">
      <BottomSheet
        ref={sheetRef}
        index={0}
        snapPoints={snapPoints}
        enableDynamicSizing={false}
        enablePanDownToClose
        onClose={handleClose}
        backdropComponent={renderBackdrop}
        handleComponent={null}
        backgroundStyle={{ backgroundColor: surface, borderTopLeftRadius: RADIUS, borderTopRightRadius: RADIUS }}
        keyboardBehavior={keyboardAware ? 'interactive' : 'extend'}
        keyboardBlurBehavior={keyboardAware ? 'restore' : 'none'}
        android_keyboardInputMode={keyboardAware ? 'adjustResize' : 'adjustPan'}
      >
        {children}
      </BottomSheet>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // Above the screen content, like the Modal it replaces.
  root: { ...StyleSheet.absoluteFillObject, zIndex: 999, elevation: 999 },
});
