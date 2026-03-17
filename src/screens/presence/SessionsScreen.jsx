import React, { useEffect } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../contexts/ThemeContext';
import { useSessions } from '../../presence/hooks';

export default function SessionsScreen() {
  const { theme } = useTheme();
  const { sessions, listSessions, terminateSession, terminateOtherSessions } = useSessions();

  useEffect(() => {
    listSessions();
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background, padding: 16 }}>
      <Text style={{ color: theme.colors.primaryTextColor, fontFamily: 'Roboto-Bold', fontSize: 20 }}>Active Sessions</Text>

      <TouchableOpacity onPress={terminateOtherSessions} style={{ marginTop: 12, alignSelf: 'flex-start', backgroundColor: '#FF3B30', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 12 }}>
        <Text style={{ color: '#fff' }}>Terminate Other Sessions</Text>
      </TouchableOpacity>

      <FlatList
        data={sessions}
        keyExtractor={(item, index) => String(item.sessionId || index)}
        contentContainerStyle={{ paddingTop: 16 }}
        renderItem={({ item }) => (
          <View style={{ padding: 12, borderWidth: 1, borderColor: theme.colors.borderColor, borderRadius: 10, marginBottom: 10 }}>
            <Text style={{ color: theme.colors.primaryTextColor }}>{item.sessionName || 'Unnamed Session'}</Text>
            <Text style={{ color: theme.colors.placeHolderTextColor, fontSize: 12 }}>{item.deviceType || 'unknown'} • {item.lastActive || 'active now'}</Text>
            {!item.isCurrent && (
              <TouchableOpacity onPress={() => terminateSession(item.sessionId)} style={{ marginTop: 8 }}>
                <Text style={{ color: '#FF3B30' }}>Terminate</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      />
    </View>
  );
}