import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
} from "react-native";
import { useDispatch, useSelector } from "react-redux";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import { fetchBlockedContacts, unblockUser } from "../../Redux/Reducer/Block/Block.reducer";
import ChatDatabase from "../../services/ChatDatabase";

// Settings → Privacy → Blocked Contacts. Lists everyone the user has blocked
// (profile photo, name, phone, block date) with search + unblock.
export default function BlockedContacts({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const dispatch = useDispatch();

  const contacts = useSelector((s) => s?.block?.contacts || []);
  const isLoading = useSelector((s) => s?.block?.isLoading);

  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [unblockingId, setUnblockingId] = useState(null);

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const sepClr = isDarkMode ? "rgba(255,255,255,0.07)" : "rgba(15,30,50,0.07)";
  const accent = theme.colors.primaryColor || "#03b0a2";

  const load = useCallback(async () => {
    // SQLite-first for instant render, then refresh from server.
    try {
      const cached = await ChatDatabase.loadBlockedContacts();
      if (cached?.length) {
        dispatch({ type: "block/hydrateBlocked", payload: cached });
      }
    } catch {}
    const res = await dispatch(fetchBlockedContacts({ search: "", page: 1, limit: 100 }));
    if (fetchBlockedContacts.fulfilled.match(res)) {
      try { await ChatDatabase.saveBlockedContacts(res.payload?.items || []); } catch {}
    }
  }, [dispatch]);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        (c.fullName || "").toLowerCase().includes(q) ||
        (c.phone || "").toLowerCase().includes(q),
    );
  }, [contacts, search]);

  const handleUnblock = useCallback(
    (item) => {
      Alert.alert(
        `Unblock ${item.fullName || "this contact"}?`,
        "They will be able to call you and send you messages.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Unblock",
            style: "destructive",
            onPress: async () => {
              setUnblockingId(item.userId);
              const res = await dispatch(unblockUser(item.userId));
              setUnblockingId(null);
              if (unblockUser.fulfilled.match(res)) {
                try {
                  const remaining = (contacts || []).filter((c) => String(c.userId) !== String(item.userId));
                  await ChatDatabase.saveBlockedContacts(remaining);
                } catch {}
              } else {
                Alert.alert("Couldn't unblock", res.payload || "Please try again.");
              }
            },
          },
        ],
      );
    },
    [dispatch, contacts],
  );

  const formatDate = (d) => {
    if (!d) return "";
    try {
      const date = typeof d === "number" ? new Date(d) : new Date(d);
      return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    } catch {
      return "";
    }
  };

  const renderItem = ({ item }) => (
    <View style={[styles.row, { borderBottomColor: sepClr }]}>
      {item.profileImage ? (
        <Image source={{ uri: item.profileImage }} style={styles.avatar} />
      ) : (
        <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: accent }]}>
          <Text style={styles.avatarInitial}>{(item.fullName || "?").charAt(0).toUpperCase()}</Text>
        </View>
      )}
      <View style={styles.rowText}>
        <Text numberOfLines={1} style={[styles.name, { color: primaryText }]}>
          {item.fullName || "Unknown"}
        </Text>
        <Text numberOfLines={1} style={[styles.meta, { color: subText }]}>
          {item.phone ? `${item.phone} · ` : ""}Blocked {formatDate(item.blockedAt)}
        </Text>
      </View>
      <TouchableOpacity
        onPress={() => handleUnblock(item)}
        style={[styles.unblockBtn, { borderColor: accent }]}
        disabled={unblockingId === item.userId}
      >
        {unblockingId === item.userId ? (
          <ActivityIndicator size="small" color={accent} />
        ) : (
          <Text style={[styles.unblockText, { color: accent }]}>Unblock</Text>
        )}
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Blocked Contacts</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={[styles.searchWrap, { backgroundColor: cardBg }]}>
        <Ionicons name="search" size={18} color={subText} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search blocked contacts"
          placeholderTextColor={subText}
          style={[styles.searchInput, { color: primaryText }]}
        />
      </View>

      {isLoading && !contacts.length ? (
        <View style={styles.center}>
          <ActivityIndicator color={accent} />
        </View>
      ) : filtered.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="person-remove-outline" size={44} color={subText} />
          <Text style={[styles.emptyText, { color: subText }]}>
            {search ? "No matches" : "You haven't blocked anyone"}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.userId)}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={accent} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 8,
    gap: 6,
  },
  headerBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontFamily: "Roboto-Bold", fontSize: 22, letterSpacing: -0.3 },
  headerSpacer: { width: 40 },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: 16,
    marginVertical: 8,
    paddingHorizontal: 14,
    height: 44,
    borderRadius: 12,
    gap: 8,
  },
  searchInput: { flex: 1, fontFamily: "Roboto-Regular", fontSize: 15, padding: 0 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10 },
  emptyText: { fontFamily: "Roboto-Regular", fontSize: 15 },
  listContent: { paddingBottom: 30 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: { width: 48, height: 48, borderRadius: 24 },
  avatarFallback: { alignItems: "center", justifyContent: "center" },
  avatarInitial: { color: "#fff", fontFamily: "Roboto-Bold", fontSize: 19 },
  rowText: { flex: 1 },
  name: { fontFamily: "Roboto-Medium", fontSize: 16 },
  meta: { fontFamily: "Roboto-Regular", fontSize: 13, marginTop: 3 },
  unblockBtn: {
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1.4,
    minWidth: 84,
    alignItems: "center",
  },
  unblockText: { fontFamily: "Roboto-Medium", fontSize: 14 },
});
