import React, { memo } from 'react';
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../../contexts/ThemeContext';
import { withAlpha } from './colorUtils';

/**
 * A single permission row: icon, title, reason, and the action for its current state.
 *
 * Purely presentational — it renders the item the view model handed it and reports
 * taps back up. It never touches the OS, and there is no state in which it can show
 * "Allowed" without the view model having observed a real grant.
 */
function PermissionListItem({ item, onAllow, onOpenSettings }) {
  const { theme, isDarkMode } = useTheme();
  const colors = theme.colors;

  const chipBackground = withAlpha(item.accent, isDarkMode ? 0.22 : 0.12);

  const renderAction = () => {
    if (item.isBusy) {
      return (
        <View style={styles.actionSlot}>
          <ActivityIndicator size="small" color={colors.themeColor} />
        </View>
      );
    }

    if (item.isSatisfied) {
      return (
        <View style={[styles.actionSlot, styles.grantedSlot]}>
          <Ionicons name="checkmark-circle" size={22} color={colors.themeColor} />
          <Text style={[styles.grantedText, { color: colors.themeColor }]}>Allowed</Text>
        </View>
      );
    }

    if (item.isBlocked) {
      return (
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={() => onOpenSettings(item)}
          style={[styles.actionButton, { borderColor: colors.danger }]}
          accessibilityRole="button"
          accessibilityLabel={`Open settings to allow ${item.title}`}
        >
          <Text style={[styles.actionButtonText, { color: colors.danger }]}>Settings</Text>
        </TouchableOpacity>
      );
    }

    return (
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={() => onAllow(item)}
        style={[styles.actionButton, { borderColor: colors.themeColor }]}
        accessibilityRole="button"
        accessibilityLabel={`Allow ${item.title}`}
      >
        <Text style={[styles.actionButtonText, { color: colors.themeColor }]}>Allow</Text>
      </TouchableOpacity>
    );
  };

  return (
    <View
      style={[
        styles.row,
        {
          backgroundColor: colors.surface,
          borderColor: item.isSatisfied ? withAlpha(colors.themeColor, 0.35) : colors.borderColor,
        },
      ]}
    >
      <View style={[styles.iconChip, { backgroundColor: chipBackground }]}>
        <Ionicons name={item.icon} size={20} color={item.accent} />
      </View>

      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.primaryTextColor }]} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.description, { color: colors.secondaryTextColor }]}>
          {item.isBlocked ? item.settingsHint : item.description}
        </Text>
      </View>

      {renderAction()}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 14,
    marginBottom: 10,
  },
  iconChip: {
    width: 42,
    height: 42,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: {
    flex: 1,
    paddingHorizontal: 12,
  },
  title: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 15,
  },
  description: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12.5,
    lineHeight: 17,
    marginTop: 2,
  },
  actionSlot: {
    minWidth: 74,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grantedSlot: {
    gap: 2,
  },
  grantedText: {
    fontFamily: 'Roboto-Medium',
    fontSize: 11,
  },
  actionButton: {
    minWidth: 74,
    height: 36,
    borderRadius: 10,
    borderWidth: 1.4,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  actionButtonText: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 13.5,
  },
});

export default memo(PermissionListItem);
