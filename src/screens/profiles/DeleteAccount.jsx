import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import { DELETE_REASONS, deleteAccount } from "../../Redux/Services/Account/Account.Services";
import { clearLocalStorageAndDisconnect } from "../../Redux/Services/Socket/socket";

// What deleting the account removes — shown verbatim on the warning step.
const WARNINGS = [
  "Remove profile information.",
  "Remove profile photo.",
  "Leave all groups.",
  "Delete message backups.",
  "Remove call history.",
  "Delete linked devices.",
  "Delete status updates.",
  "Delete notifications.",
  "Remove contacts synchronization.",
];

export default function DeleteAccount({ navigation }) {
  const { theme, isDarkMode } = useTheme();

  // step 1 = pick a reason, step 2 = WhatsApp-style warning screen.
  const [step, setStep] = useState(1);
  const [reason, setReason] = useState(null);
  const [customReason, setCustomReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = isDarkMode ? "#0B141A" : "#F7F8FA";
  const cardBg = isDarkMode ? "#16222C" : "#FFFFFF";
  const sepClr = isDarkMode ? "rgba(255,255,255,0.07)" : "rgba(15,30,50,0.07)";
  const DANGER = "#E53935";

  const isOther = reason === "Other";
  const canContinue = !!reason && (!isOther || customReason.trim().length >= 2);

  const finalReason = isOther ? customReason.trim() : reason;

  // The actual deletion — runs after the final confirmation popup. On success
  // the server has logged this device out everywhere; we wipe all local state
  // (SQLite, caches, MMKV, AsyncStorage) and return to the auth screen so the
  // app behaves like a fresh install.
  const performDeletion = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      await deleteAccount({ reason: finalReason, customReason: isOther ? customReason.trim() : "" });

      // Complete local-device cleanup + socket disconnect.
      await clearLocalStorageAndDisconnect();

      navigation.reset({ index: 0, routes: [{ name: "LoginEmail" }] });
      Alert.alert(
        "Account deleted",
        "Your account has been deleted. You can recover it within 30 days by contacting support.",
      );
    } catch (err) {
      Alert.alert("Couldn't delete account", typeof err === "string" ? err : "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // Final, explicit confirmation popup before anything is destroyed.
  const confirmDeletion = () => {
    Alert.alert(
      "Delete my account?",
      "This will permanently delete your account and cannot be undone. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete My Account", style: "destructive", onPress: performDeletion },
      ],
    );
  };

  const Header = ({ title }) => (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => (step === 2 ? setStep(1) : navigation.goBack())}
        activeOpacity={0.6}
        style={styles.headerBackBtn}
      >
        <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
      </TouchableOpacity>
      <Text style={[styles.headerTitle, { color: primaryText }]}>{title}</Text>
      <View style={styles.headerSpacer} />
    </View>
  );

  // ─── Step 1: reason ───
  if (step === 1) {
    return (
      <View style={[styles.container, { backgroundColor: pageBg }]}>
        <Header title="Delete Account" />
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          <Text style={[styles.lead, { color: primaryText }]}>Why are you deleting your account?</Text>
          <Text style={[styles.leadSub, { color: subText }]}>
            Please tell us a reason. This helps us improve.
          </Text>

          <View style={[styles.sectionCard, { backgroundColor: cardBg }]}>
            {DELETE_REASONS.map((r, i) => {
              const selected = reason === r;
              return (
                <View key={r}>
                  <TouchableOpacity
                    activeOpacity={0.6}
                    style={styles.radioRow}
                    onPress={() => setReason(r)}
                  >
                    <Text style={[styles.radioLabel, { color: primaryText }]}>{r}</Text>
                    <Ionicons
                      name={selected ? "radio-button-on" : "radio-button-off"}
                      size={22}
                      color={selected ? accent : subText}
                    />
                  </TouchableOpacity>
                  {i !== DELETE_REASONS.length - 1 && (
                    <View style={[styles.separator, { backgroundColor: sepClr }]} />
                  )}
                </View>
              );
            })}
          </View>

          {isOther && (
            <TextInput
              value={customReason}
              onChangeText={setCustomReason}
              placeholder="Tell us more…"
              placeholderTextColor={subText}
              multiline
              style={[styles.input, { backgroundColor: cardBg, color: primaryText, borderColor: sepClr }]}
              maxLength={500}
            />
          )}

          <TouchableOpacity
            activeOpacity={0.8}
            disabled={!canContinue}
            onPress={() => setStep(2)}
            style={[styles.primaryBtn, { backgroundColor: canContinue ? accent : sepClr }]}
          >
            <Text style={[styles.primaryBtnText, { color: canContinue ? "#fff" : subText }]}>Continue</Text>
          </TouchableOpacity>
        </ScrollView>
      </View>
    );
  }

  // ─── Step 2: warning ───
  return (
    <View style={[styles.container, { backgroundColor: pageBg }]}>
      <Header title="Delete Account" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.warnIconWrap}>
          <View style={[styles.warnCircle, { backgroundColor: DANGER + "1A" }]}>
            <Ionicons name="warning-outline" size={38} color={DANGER} />
          </View>
        </View>

        <Text style={[styles.lead, styles.center, { color: primaryText }]}>
          Deleting your account will:
        </Text>

        <View style={[styles.sectionCard, styles.warnCard, { backgroundColor: cardBg }]}>
          {WARNINGS.map((w) => (
            <View key={w} style={styles.warnRow}>
              <Ionicons name="close-circle" size={18} color={DANGER} />
              <Text style={[styles.warnText, { color: primaryText }]}>{w}</Text>
            </View>
          ))}
        </View>

        <Text style={[styles.disclaimer, { color: subText }]}>
          This action is permanent and cannot be undone after the recovery period.
        </Text>

        <TouchableOpacity
          activeOpacity={0.85}
          disabled={submitting}
          onPress={confirmDeletion}
          style={[styles.dangerBtn, { backgroundColor: DANGER, opacity: submitting ? 0.7 : 1 }]}
        >
          {submitting ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.dangerBtnText}>Delete My Account</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity
          activeOpacity={0.7}
          disabled={submitting}
          onPress={() => navigation.goBack()}
          style={[styles.cancelBtn, { backgroundColor: cardBg }]}
        >
          <Text style={[styles.cancelBtnText, { color: primaryText }]}>Cancel</Text>
        </TouchableOpacity>
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
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40, paddingTop: 8 },

  lead: { fontFamily: "Roboto-SemiBold", fontSize: 18, lineHeight: 24, marginBottom: 4 },
  leadSub: { fontFamily: "Roboto-Regular", fontSize: 14, lineHeight: 19, marginBottom: 18 },
  center: { textAlign: "center", marginTop: 6 },

  sectionCard: { borderRadius: 14, overflow: "hidden" },
  radioRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 15,
    minHeight: 54,
  },
  radioLabel: { fontFamily: "Roboto-Regular", fontSize: 16, flex: 1, marginRight: 12 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },

  input: {
    marginTop: 14,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
    minHeight: 90,
    textAlignVertical: "top",
    fontFamily: "Roboto-Regular",
    fontSize: 15,
  },

  primaryBtn: {
    marginTop: 26,
    paddingVertical: 15,
    borderRadius: 14,
    alignItems: "center",
  },
  primaryBtnText: { fontFamily: "Roboto-SemiBold", fontSize: 16 },

  // Warning step
  warnIconWrap: { alignItems: "center", marginTop: 8, marginBottom: 4 },
  warnCircle: { width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center" },
  warnCard: { marginTop: 16, paddingVertical: 6 },
  warnRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 11 },
  warnText: { fontFamily: "Roboto-Regular", fontSize: 15, flex: 1, lineHeight: 20 },
  disclaimer: {
    fontFamily: "Roboto-Regular",
    fontSize: 13,
    lineHeight: 18,
    textAlign: "center",
    marginTop: 18,
    marginHorizontal: 8,
  },

  dangerBtn: { marginTop: 22, paddingVertical: 15, borderRadius: 14, alignItems: "center" },
  dangerBtnText: { fontFamily: "Roboto-SemiBold", fontSize: 16, color: "#fff" },
  cancelBtn: { marginTop: 12, paddingVertical: 15, borderRadius: 14, alignItems: "center" },
  cancelBtnText: { fontFamily: "Roboto-SemiBold", fontSize: 16 },
});
