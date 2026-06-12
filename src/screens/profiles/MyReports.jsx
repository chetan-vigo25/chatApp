import React, { useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator, RefreshControl,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { useFocusEffect } from "@react-navigation/native";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import { fetchMyReports } from "../../services/ReportService";
import { REPORT_TYPE_LABELS, REPORT_STATUS_LABELS } from "../../constant/reportReasons";

const STATUS_COLORS = {
  pending: "#F59E0B",
  under_review: "#3B82F6",
  reviewing: "#3B82F6",
  resolved: "#22C55E",
  rejected: "#EF4444",
  closed: "#94A3B8",
};

const TYPE_ICONS = {
  message: "chatbubble-ellipses-outline",
  chat: "chatbubbles-outline",
  user: "person-outline",
  status: "radio-outline",
  group: "people-outline",
};

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

export default function MyReports({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;

  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((isRefresh = false) => {
    if (!isRefresh) setLoading(true);
    fetchMyReports({ page: 1, limit: 50 })
      .then((res) => setReports(res.reports || []))
      .catch(() => {})
      .finally(() => { setLoading(false); setRefreshing(false); });
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderItem = ({ item }) => {
    const statusColor = STATUS_COLORS[item.status] || subText;
    const statusLabel = REPORT_STATUS_LABELS[item.status] || item.status;
    const typeLabel = REPORT_TYPE_LABELS[item.reportType] || item.reportType;
    return (
      <View style={[styles.card, { backgroundColor: cardBg }]}>
        <View style={styles.cardTop}>
          <View style={styles.typeWrap}>
            <View style={[styles.typeIcon, { backgroundColor: accent + "18" }]}>
              <Ionicons name={TYPE_ICONS[item.reportType] || "flag-outline"} size={16} color={accent} />
            </View>
            <Text style={[styles.typeLabel, { color: primaryText }]}>{typeLabel} report</Text>
          </View>
          <View style={[styles.statusPill, { backgroundColor: statusColor + "1A" }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>
        <Text style={[styles.reason, { color: subText }]} numberOfLines={2}>{item.reason}</Text>
        {item.resolutionNote ? (
          <Text style={[styles.note, { color: subText }]} numberOfLines={2}>Moderator: {item.resolutionNote}</Text>
        ) : null}
        <View style={styles.cardBottom}>
          <Text style={[styles.meta, { color: subText }]}>{item.reportId}</Text>
          <Text style={[styles.meta, { color: subText }]}>{timeAgo(item.createdAt)}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>My Reports</Text>
        <View style={styles.headerBackBtn} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={accent} /></View>
      ) : reports.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="flag-outline" size={56} color={subText} />
          <Text style={[styles.emptyTitle, { color: primaryText }]}>No reports yet</Text>
          <Text style={[styles.emptyText, { color: subText }]}>Reports you submit will appear here with their review status.</Text>
        </View>
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(r) => r._id || r.reportId}
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
  listContent: { paddingHorizontal: 16, paddingBottom: 30, paddingTop: 4 },
  card: { borderRadius: 16, padding: 14, marginBottom: 10 },
  cardTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  typeWrap: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  typeIcon: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  typeLabel: { fontFamily: "Roboto-SemiBold", fontSize: 14 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 9, paddingVertical: 3, borderRadius: 20 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontFamily: "Roboto-Medium", fontSize: 11 },
  reason: { fontFamily: "Roboto-Regular", fontSize: 13.5, marginBottom: 3 },
  note: { fontFamily: "Roboto-Regular", fontSize: 12, fontStyle: "italic", marginTop: 2 },
  cardBottom: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 10 },
  meta: { fontFamily: "Roboto-Regular", fontSize: 11.5 },
});
