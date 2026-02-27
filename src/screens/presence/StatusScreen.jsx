import React, { useState } from 'react';
import { ScrollView, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { useMyPresence } from '../../presence/hooks';

const STATUS_OPTIONS = ['online', 'away', 'busy', 'offline'];

export default function StatusScreen() {
  const { theme } = useTheme();
  const {
    presence,
    setStatus,
    setCustomStatus,
    clearCustomStatus,
    setInvisible,
    isLoading,
  } = useMyPresence();

  const [customStatus, setCustom] = useState(presence.customStatus || '');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.background, padding: 16 }}>
      <Text style={{ color: theme.colors.primaryTextColor, fontSize: 20, fontFamily: 'Poppins-Bold' }}>My Status</Text>

      <View style={{ marginTop: 16, gap: 10 }}>
        {STATUS_OPTIONS.map((status) => (
          <TouchableOpacity
            key={status}
            onPress={() => setStatus(status)}
            style={{
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: presence.status === status ? theme.colors.themeColor : theme.colors.borderColor,
              backgroundColor: theme.colors.surface,
            }}
          >
            <Text style={{ color: theme.colors.primaryTextColor, textTransform: 'capitalize' }}>{status}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={{ color: theme.colors.primaryTextColor, marginTop: 20, marginBottom: 8, fontFamily: 'Poppins-Medium' }}>Custom status</Text>
      <TextInput
        value={customStatus}
        onChangeText={setCustom}
        placeholder="What are you up to?"
        placeholderTextColor={theme.colors.placeHolderTextColor}
        style={{
          borderWidth: 1,
          borderColor: theme.colors.borderColor,
          borderRadius: 10,
          padding: 12,
          color: theme.colors.primaryTextColor,
        }}
      />
      <Text style={{ color: theme.colors.placeHolderTextColor, marginTop: 6 }}>{customStatus.length}/100</Text>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
        <TouchableOpacity onPress={() => setCustomStatus(customStatus)} style={{ backgroundColor: theme.colors.themeColor, padding: 12, borderRadius: 8 }}>
          <Text style={{ color: theme.colors.textWhite }}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={clearCustomStatus} style={{ backgroundColor: theme.colors.menuBackground, padding: 12, borderRadius: 8 }}>
          <Text style={{ color: theme.colors.primaryTextColor }}>Clear</Text>
        </TouchableOpacity>
      </View>

      <View style={{ marginTop: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Poppins-Medium' }}>Invisible mode</Text>
        <Switch value={presence.isInvisible} onValueChange={(value) => setInvisible(value)} />
      </View>

      {isLoading && <Text style={{ color: theme.colors.placeHolderTextColor, marginTop: 12 }}>Updating status...</Text>}
    </ScrollView>
  );
}
