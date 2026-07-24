import React from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";

// Privacy & Account hub — groups account-level privacy controls and the
// destructive "Delete account" entry point (WhatsApp-style).
export default function PrivacyAccount({ navigation }) {
  const { theme, isDarkMode } = useTheme();

  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const iconColor = theme.colors.iconColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const sepClr = isDarkMode ? "rgba(255,255,255,0.07)" : "rgba(15,30,50,0.07)";

  const items = [
    {
      icon: "person-remove-outline",
      label: "Blocked Contacts",
      subtitle: "Manage who you've blocked",
      onPress: () => navigation.navigate("BlockedContacts"),
    },
    {
      icon: "phone-portrait-outline",
      label: "Linked Devices",
      subtitle: "Devices logged into your account",
      onPress: () => navigation.navigate("LinkDevice"),
    },
    {
      icon: "trash-outline",
      label: "Delete Account",
      subtitle: "Permanently delete your account",
      destructive: true,
      onPress: () => navigation.navigate("DeleteAccount"),
    },
  ];

  const renderItem = (item, isLast) => {
    const color = item.destructive ? "#E53935" : primaryText;
    const icon = item.destructive ? "#E53935" : iconColor;
    return (
      <View key={item.label}>
        <TouchableOpacity onPress={item.onPress} activeOpacity={0.6} style={styles.menuItem}>
          <View style={styles.menuIconWrap}>
            <Ionicons name={item.icon} size={23} color={icon} />
          </View>
          <View style={styles.menuTextWrap}>
            <Text style={[styles.menuLabel, { color }]}>{item.label}</Text>
            {item.subtitle ? (
              <Text numberOfLines={1} style={[styles.menuSubtitle, { color: subText }]}>
                {item.subtitle}
              </Text>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={18} color={subText} />
        </TouchableOpacity>
        {!isLast && <View style={[styles.separator, { backgroundColor: sepClr }]} />}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
          <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: primaryText }]}>Privacy & Account</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
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
  scrollContent: { paddingHorizontal: 12, paddingBottom: 40, paddingTop: 8 },
  sectionCard: { borderRadius: 14, overflow: "hidden" },
  menuItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 14,
    gap: 16,
    minHeight: 58,
  },
  menuIconWrap: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  menuTextWrap: { flex: 1 },
  menuLabel: { fontFamily: "Roboto-Regular", fontSize: 16, lineHeight: 21 },
  menuSubtitle: { fontFamily: "Roboto-Regular", fontSize: 13, marginTop: 2, lineHeight: 17 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 56 },
});
