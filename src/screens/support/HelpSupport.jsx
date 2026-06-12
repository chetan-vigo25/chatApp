import React from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";

// Help & Support hub (Settings → Help & Support). Entry points for FAQs,
// starting a support chat, raising a ticket, and reviewing past requests.
export default function HelpSupport({ navigation }) {
  const { theme, isDarkMode } = useTheme();

  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const sepClr = isDarkMode ? "rgba(255,255,255,0.07)" : "rgba(15,30,50,0.07)";

  const items = [
    {
      icon: "help-circle-outline",
      label: "FAQs",
      subtitle: "Common questions and answers",
      onPress: () => navigation.navigate("SupportFaqs"),
    },
    {
      icon: "chatbubble-ellipses-outline",
      label: "Contact Support",
      subtitle: "Start a chat with our support team",
      onPress: () => navigation.navigate("CreateTicket", { mode: "contact" }),
    },
    // {
    //   icon: "create-outline",
    //   label: "Create Ticket",
    //   subtitle: "Report an issue or request a feature",
    //   onPress: () => navigation.navigate("CreateTicket"),
    // },
    {
      icon: "receipt-outline",
      label: "My Support Requests",
      subtitle: "Track your tickets and replies",
      onPress: () => navigation.navigate("MyTickets"),
    },
  ];

  const renderItem = (item, isLast) => (
    <View key={item.label}>
      <TouchableOpacity onPress={item.onPress} activeOpacity={0.6} style={styles.menuItem}>
        <View style={[styles.iconChip, { backgroundColor: accent + "18" }]}>
          <Ionicons name={item.icon} size={21} color={accent} />
        </View>
        <View style={styles.menuTextWrap}>
          <Text style={[styles.menuLabel, { color: primaryText }]}>{item.label}</Text>
          <Text numberOfLines={1} style={[styles.menuSubtitle, { color: subText }]}>{item.subtitle}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={subText} />
      </TouchableOpacity>
      {!isLast && <View style={[styles.separator, { backgroundColor: sepClr }]} />}
    </View>
  );

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Help & Support</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <Text style={[styles.intro, { color: subText }]}>
          We're here to help. Browse common questions or reach our team directly.
        </Text>
        <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
          {items.map((item, i) => renderItem(item, i === items.length - 1))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 6,
  },
  headerBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontFamily: "Roboto-Bold", fontSize: 22, letterSpacing: -0.3 },
  headerSpacer: { width: 40 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40, paddingTop: 6 },
  intro: { fontFamily: "Roboto-Regular", fontSize: 13.5, lineHeight: 19, marginBottom: 16, marginHorizontal: 4 },
  sectionCard: { borderRadius: 16, overflow: "hidden" },
  menuItem: { flexDirection: "row", alignItems: "center", paddingHorizontal: 14, paddingVertical: 13, gap: 14, minHeight: 62 },
  iconChip: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  menuTextWrap: { flex: 1 },
  menuLabel: { fontFamily: "Roboto-Medium", fontSize: 16, lineHeight: 21 },
  menuSubtitle: { fontFamily: "Roboto-Regular", fontSize: 13, marginTop: 2, lineHeight: 17 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 70 },
});
