import React from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  TouchableWithoutFeedback,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../contexts/ThemeContext';

/**
 * Anchored popover card — the long-press message menu and (potentially) any
 * other "floating list of actions" surface.
 *
 * Geometry is fixed (see ROW_H / CARD_PAD below); the HOST computes where the
 * card sits and passes it as `anchor`, because only the host knows which
 * bubble was pressed. `children` render ABOVE the card inside the same
 * absolute wrapper — that is where the quick-reaction pill goes.
 *
 * Props
 *   visible   boolean
 *   onClose   () => void        scrim tap, row tap, Android back
 *   items     Action[]          { id, label, icon, danger?, onPress? }
 *   anchor    ViewStyle         absolute position for the wrapper
 *   children  node              rendered above the card (reaction pill)
 */

// Row height and card padding are exported so the host can compute the card's
// height BEFORE it renders — the above/below flip needs it up front.
export const MENU_ROW_H = 48;      // paddingVertical 8 + disc 32 + 8
export const MENU_CARD_PAD = 12;   // card paddingVertical 6 × 2
export const MENU_WIDTH = 224;     // between card minWidth 196 and maxWidth 280

export const menuCardHeight = (count) => count * MENU_ROW_H + MENU_CARD_PAD;

const MenuPopover = ({ visible, onClose, items = [], anchor, children }) => {
  const { theme, isDarkMode } = useTheme();
  const colors = theme.colors;

  return (
    <Modal
      visible={!!visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      // REQUIRED on Android: without it the Modal starts below the status bar
      // and every measureInWindow y the host passed is off by its height.
      statusBarTranslucent
    >
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop} />
      </TouchableWithoutFeedback>

      {/* box-none: the wrapper is wider than the card, and without this it
          swallows scrim taps in the empty space beside it. */}
      <View style={[styles.anchorWrap, anchor]} pointerEvents="box-none">
        {children}

        {items.length > 0 && (
          <View
            style={[
              styles.card,
              { backgroundColor: colors.cardBackground, borderColor: colors.divider },
              // A shadow is invisible on a dark card over a dark scrim, and on
              // Android it just costs frames — the hairline border separates it.
              isDarkMode ? null : styles.shadow,
            ]}
          >
            {items.map((item) => (
              <TouchableOpacity
                key={item.id}
                activeOpacity={0.6}
                // Close FIRST: if the action navigates, the Modal must start
                // unmounting before the transition or the Android dim layer can
                // outlive it and the next screen opens greyed out.
                onPress={() => {
                  onClose?.();
                  item.onPress?.();
                }}
                style={styles.item}
              >
                <View style={[styles.disc, { backgroundColor: colors.surface }]}>
                  <Ionicons
                    name={item.icon}
                    size={17}
                    color={item.danger ? colors.danger : colors.iconColor}
                  />
                </View>
                <Text
                  numberOfLines={1}
                  style={[
                    styles.label,
                    {
                      color: item.danger ? colors.danger : colors.primaryTextColor,
                      fontFamily: theme.fonts?.medium || 'Roboto-Medium',
                    },
                  ]}
                >
                  {item.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.25)',
  },
  anchorWrap: {
    position: 'absolute',
  },
  card: {
    minWidth: 196,
    maxWidth: 280,
    borderRadius: 18,
    paddingVertical: 6,
    borderWidth: StyleSheet.hairlineWidth,
    // Static, never animated: animating elevation makes Android recompute the
    // shadow every frame. The Modal's own fade is a free native animation.
    elevation: 18,
  },
  shadow: {
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    marginHorizontal: 6,
  },
  disc: {
    width: 32,
    height: 32,
    borderRadius: 11, // squircle, deliberately not a circle
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 15,
    flex: 1,
  },
});

export default MenuPopover;
