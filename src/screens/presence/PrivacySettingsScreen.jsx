import React from 'react';
import { Switch, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { usePresenceSettings } from '../../presence/hooks';

const privacyOptions = ['everyone', 'contacts', 'nobody'];

export default function PrivacySettingsScreen() {
  const { theme } = useTheme();
  const { settings, updateSettings, resetToDefault } = usePresenceSettings();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, padding: 16 }}>
      <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Bold', fontSize: 20 }}>Privacy Settings</Text>

      <View style={{ marginTop: 16, gap: 12 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: theme.colors.primaryTextColor }}>Show Last Seen</Text>
          <Switch value={settings.showLastSeen} onValueChange={(value) => updateSettings({ showLastSeen: value })} />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: theme.colors.primaryTextColor }}>Show Online Status</Text>
          <Switch value={settings.showOnlineStatus} onValueChange={(value) => updateSettings({ showOnlineStatus: value })} />
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: theme.colors.primaryTextColor }}>Typing Indicators</Text>
          <Switch value={settings.typingIndicators} onValueChange={(value) => updateSettings({ typingIndicators: value })} />
        </View>
      </View>

      <Text style={{ color: theme.colors.primaryTextColor, marginTop: 24, marginBottom: 10 }}>Last Seen Visibility</Text>
      <View style={{ gap: 8 }}>
        {privacyOptions.map((option) => (
          <TouchableOpacity
            key={option}
            onPress={() => updateSettings({ privacyLevel: option })}
            style={{
              borderWidth: 1,
              borderColor: settings.privacyLevel === option ? theme.colors.themeColor : theme.colors.borderColor,
              borderRadius: 8,
              padding: 10,
            }}
          >
            <Text style={{ color: theme.colors.primaryTextColor, textTransform: 'capitalize' }}>{option}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity onPress={resetToDefault} style={{ marginTop: 24, backgroundColor: theme.colors.menuBackground, padding: 12, borderRadius: 8 }}>
        <Text style={{ color: theme.colors.primaryTextColor }}>Reset to default</Text>
      </TouchableOpacity>
    </View>
  );
}