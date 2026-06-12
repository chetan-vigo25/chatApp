import React, { useEffect, useState, useCallback } from "react";
import {
  View, Text, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, LayoutAnimation, Platform, UIManager,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import { getFaqs } from "../../Redux/Services/Support/Support.Services";

if (Platform.OS === "android" && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export default function SupportFaqs({ navigation }) {
  const { theme, isDarkMode } = useTheme();
  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const sepClr = isDarkMode ? "rgba(255,255,255,0.07)" : "rgba(15,30,50,0.07)";

  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openKey, setOpenKey] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    getFaqs().then(setGroups).catch(() => setGroups([])).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = (key) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpenKey((k) => (k === key ? null : key));
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>FAQs</Text>
        <View style={styles.headerSpacer} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator color={accent} /></View>
      ) : groups.length === 0 ? (
        <View style={styles.center}>
          <Ionicons name="help-buoy-outline" size={56} color={subText} />
          <Text style={[styles.emptyText, { color: subText }]}>No FAQs available yet.</Text>
          <TouchableOpacity onPress={() => navigation.navigate("CreateTicket")} style={[styles.emptyBtn, { backgroundColor: accent }]}>
            <Text style={styles.emptyBtnText}>Contact Support</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          {groups.map((grp) => (
            <View key={grp.category} style={styles.group}>
              <Text style={[styles.groupTitle, { color: subText }]}>{grp.category.toUpperCase()}</Text>
              <View style={[styles.card, { backgroundColor: cardBg }]}>
                {grp.items.map((item, i) => {
                  const key = item._id || `${grp.category}-${i}`;
                  const open = openKey === key;
                  return (
                    <View key={key}>
                      <TouchableOpacity activeOpacity={0.7} style={styles.qRow} onPress={() => toggle(key)}>
                        <Text style={[styles.question, { color: primaryText }]}>{item.question}</Text>
                        <Ionicons name={open ? "chevron-up" : "chevron-down"} size={18} color={subText} />
                      </TouchableOpacity>
                      {open && <Text style={[styles.answer, { color: subText }]}>{item.answer}</Text>}
                      {i !== grp.items.length - 1 && <View style={[styles.sep, { backgroundColor: sepClr }]} />}
                    </View>
                  );
                })}
              </View>
            </View>
          ))}

          <TouchableOpacity onPress={() => navigation.navigate("CreateTicket")} activeOpacity={0.85} style={[styles.contactBtn, { borderColor: accent }]}>
            <Ionicons name="chatbubble-ellipses-outline" size={18} color={accent} />
            <Text style={[styles.contactBtnText, { color: accent }]}>Still need help? Contact Support</Text>
          </TouchableOpacity>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 6 },
  headerBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontFamily: "Roboto-Bold", fontSize: 22, letterSpacing: -0.3 },
  headerSpacer: { width: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingHorizontal: 40 },
  emptyText: { fontFamily: "Roboto-Regular", fontSize: 14 },
  emptyBtn: { marginTop: 8, paddingHorizontal: 26, paddingVertical: 12, borderRadius: 40 },
  emptyBtnText: { fontFamily: "Roboto-SemiBold", fontSize: 15, color: "#fff" },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40, paddingTop: 6 },
  group: { marginBottom: 18 },
  groupTitle: { fontFamily: "Roboto-Medium", fontSize: 11.5, letterSpacing: 0.8, marginBottom: 8, marginLeft: 6 },
  card: { borderRadius: 14, overflow: "hidden" },
  qRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 14, gap: 12 },
  question: { fontFamily: "Roboto-Medium", fontSize: 15, flex: 1, lineHeight: 20 },
  answer: { fontFamily: "Roboto-Regular", fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingBottom: 14 },
  sep: { height: StyleSheet.hairlineWidth, marginHorizontal: 16 },
  contactBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, paddingVertical: 14, borderRadius: 14, borderWidth: 1.5, marginTop: 4 },
  contactBtnText: { fontFamily: "Roboto-SemiBold", fontSize: 15 },
});
