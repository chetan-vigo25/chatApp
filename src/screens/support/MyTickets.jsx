import React, { useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, RefreshControl,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import { listTickets, categoryLabel, SUPPORT_STATUS_META } from "../../Redux/Services/Support/Support.Services";

function timeAgo(date) {
  if (!date) return "";
  const diff = Date.now() - new Date(date).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d ago` : new Date(date).toLocaleDateString();
}

export default function MyTickets({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;

  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    listTickets()
      .then(setTickets)
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderItem = ({ item }) => {
    const meta = SUPPORT_STATUS_META[item.status] || { label: item.status, color: subText };
    return (
      <TouchableOpacity
        activeOpacity={0.75}
        onPress={() => navigation.navigate("TicketChat", { ticketId: item._id, ticketNumber: item.ticketNumber })}
        style={[styles.card, { backgroundColor: cardBg }]}
      >
        <View style={styles.cardTop}>
          <Text style={[styles.ticketNo, { color: accent }]}>{item.ticketNumber}</Text>
          <View style={[styles.statusPill, { backgroundColor: meta.color + "1A" }]}>
            <View style={[styles.statusDot, { backgroundColor: meta.color }]} />
            <Text style={[styles.statusText, { color: meta.color }]}>{meta.label}</Text>
          </View>
        </View>
        <Text style={[styles.subject, { color: primaryText }]} numberOfLines={1}>{item.subject}</Text>
        <Text style={[styles.preview, { color: subText }]} numberOfLines={1}>
          {item.lastMessageText || categoryLabel(item.category)}
        </Text>
        <View style={styles.cardBottom}>
          <Text style={[styles.meta, { color: subText }]}>{categoryLabel(item.category)}</Text>
          <Text style={[styles.meta, { color: subText }]}>{timeAgo(item.lastMessageAt || item.updatedAt)}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>My Support Requests</Text>
        <TouchableOpacity onPress={() => navigation.navigate("CreateTicket")} style={styles.headerBackBtn}>
          <Ionicons name="add" size={26} color={accent} />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={accent} /></View>
      ) : tickets.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="receipt-outline" size={56} color={subText} />
          <Text style={[styles.emptyTitle, { color: primaryText }]}>No support requests yet</Text>
          <Text style={[styles.emptyText, { color: subText }]}>Create a ticket and our team will help you out.</Text>
          <TouchableOpacity onPress={() => navigation.navigate("CreateTicket")} style={[styles.emptyBtn, { backgroundColor: accent }]}>
            <Text style={styles.emptyBtnText}>Create Ticket</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={tickets}
          keyExtractor={(t) => t._id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} colors={[accent]} tintColor={accent} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 6 },
  headerBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontFamily: "Roboto-Bold", fontSize: 21, letterSpacing: -0.3 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 40 },
  emptyTitle: { fontFamily: "Roboto-SemiBold", fontSize: 17, marginTop: 6 },
  emptyText: { fontFamily: "Roboto-Regular", fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  emptyBtn: { marginTop: 10, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 40 },
  emptyBtnText: { fontFamily: "Roboto-SemiBold", fontSize: 15, color: "#fff" },
  listContent: { paddingHorizontal: 16, paddingBottom: 30, paddingTop: 4 },
  card: { borderRadius: 16, padding: 14, marginBottom: 10 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 6 },
  ticketNo: { fontFamily: "Roboto-SemiBold", fontSize: 13 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: "Roboto-Medium", fontSize: 11 },
  subject: { fontFamily: "Roboto-SemiBold", fontSize: 15.5, marginBottom: 3 },
  preview: { fontFamily: "Roboto-Regular", fontSize: 13 },
  cardBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  meta: { fontFamily: "Roboto-Regular", fontSize: 11.5 },
});
