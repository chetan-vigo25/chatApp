import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, TextInput, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { useContactsPresence } from '../../presence/hooks';
import { formatLastSeen } from '../../presence/services/lastSeenFormatter.service';

export default function ContactsPresenceScreen() {
  const { theme } = useTheme();
  const { contacts, onlineCount, refresh, isRefreshing } = useContactsPresence();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return contacts;
    return contacts.filter((item) => String(item.userId).toLowerCase().includes(query.toLowerCase()));
  }, [contacts, query]);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ padding: 16, borderBottomWidth: 1, borderBottomColor: theme.colors.borderColor }}>
        <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Bold', fontSize: 20 }}>Contacts Presence</Text>
        <Text style={{ color: theme.colors.placeHolderTextColor, marginTop: 4 }}>{onlineCount} online</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search contact"
          placeholderTextColor={theme.colors.placeHolderTextColor}
          style={{ marginTop: 10, borderWidth: 1, borderColor: theme.colors.borderColor, borderRadius: 10, padding: 10, color: theme.colors.primaryTextColor }}
        />
      </View>

      <FlatList
        data={filtered}
        keyExtractor={(item) => String(item.userId)}
        refreshControl={<RefreshControl refreshing={isRefreshing} onRefresh={refresh} />}
        renderItem={({ item }) => (
          <View style={{ padding: 14, borderBottomWidth: 1, borderBottomColor: theme.colors.borderColor, flexDirection: 'row', alignItems: 'center' }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, marginRight: 12, backgroundColor: item.presence.status === 'online' ? '#4CAF50' : item.presence.status === 'away' ? '#FFC107' : item.presence.status === 'busy' ? '#F44336' : '#9E9E9E' }} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.colors.primaryTextColor }}>{item.userId}</Text>
              <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 12 }}>
                {item.presence.customStatus || (item.presence.status === 'offline' ? formatLastSeen(item.presence.lastSeen) : item.presence.status)}
              </Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}