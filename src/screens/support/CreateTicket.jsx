import React, { useState } from "react";
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet, ActivityIndicator, Image, Alert, KeyboardAvoidingView, Platform,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { SUPPORT_CATEGORIES, createTicket } from "../../Redux/Services/Support/Support.Services";

export default function CreateTicket({ navigation, route }) {
  const isContact = route?.params?.mode === "contact";
  const { theme, isDarkMode } = useTheme();
  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = theme.colors.background;
  const cardBg = theme.colors.background;
  const sepClr = isDarkMode ? "rgba(255,255,255,0.10)" : "rgba(15,30,50,0.10)";

  const [subject, setSubject] = useState("");
  const [category, setCategory] = useState(isContact ? "other" : "technical_issue");
  const [description, setDescription] = useState("");
  const [attachment, setAttachment] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = subject.trim().length >= 3 && description.trim().length >= 5 && !submitting;

  const pickImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert("Permission needed", "Allow photo access to attach a screenshot.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        quality: 0.7,
      });
      if (!result.canceled && result.assets?.[0]) {
        const a = result.assets[0];
        setAttachment({
          uri: a.uri,
          name: a.fileName || `screenshot-${Date.now()}.jpg`,
          type: a.mimeType || "image/jpeg",
        });
      }
    } catch (e) {
      Alert.alert("Couldn't open gallery", e?.message || "Please try again.");
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const data = await createTicket({ subject: subject.trim(), category, description: description.trim(), attachment });
      navigation.replace("TicketChat", { ticketId: data.ticketId, ticketNumber: data.ticketNumber });
    } catch (err) {
      Alert.alert("Couldn't create ticket", typeof err === "string" ? err : "Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={[styles.container, { backgroundColor: pageBg }]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
            <FontAwesome6 name="arrow-left" size={19} color={primaryText} />
          </TouchableOpacity>
          <Text style={[styles.headerTitle, { color: primaryText }]}>{isContact ? "Contact Support" : "Create Ticket"}</Text>
          <View style={styles.headerSpacer} />
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
          {/* Subject */}
          <Text style={[styles.label, { color: subText }]}>Subject</Text>
          <TextInput
            value={subject}
            onChangeText={setSubject}
            placeholder="Briefly, what's the issue?"
            placeholderTextColor={subText}
            style={[styles.input, { backgroundColor: cardBg, color: primaryText, borderColor: sepClr }]}
            maxLength={150}
          />

          {/* Category */}
          <Text style={[styles.label, { color: subText }]}>Category</Text>
          <View style={styles.chipWrap}>
            {SUPPORT_CATEGORIES.map((c) => {
              const sel = category === c.value;
              return (
                <TouchableOpacity
                  key={c.value}
                  activeOpacity={0.7}
                  onPress={() => setCategory(c.value)}
                  style={[styles.chip, { borderColor: sel ? accent : sepClr, backgroundColor: sel ? accent + "1A" : cardBg }]}
                >
                  <Text style={[styles.chipText, { color: sel ? accent : primaryText }]}>{c.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* Description */}
          <Text style={[styles.label, { color: subText }]}>Description</Text>
          <TextInput
            value={description}
            onChangeText={setDescription}
            placeholder="Tell us what happened, and any steps to reproduce…"
            placeholderTextColor={subText}
            multiline
            style={[styles.input, styles.textarea, { backgroundColor: cardBg, color: primaryText, borderColor: sepClr }]}
            maxLength={5000}
          />

          {/* Attachment */}
          <Text style={[styles.label, { color: subText }]}>Attach screenshot (optional)</Text>
          {attachment ? (
            <View style={[styles.attachPreview, { backgroundColor: cardBg, borderColor: sepClr }]}>
              <Image source={{ uri: attachment.uri }} style={styles.attachThumb} />
              <Text numberOfLines={1} style={[styles.attachName, { color: primaryText }]}>{attachment.name}</Text>
              <TouchableOpacity onPress={() => setAttachment(null)} style={styles.attachRemove}>
                <Ionicons name="close-circle" size={22} color={subText} />
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity onPress={pickImage} activeOpacity={0.7} style={[styles.attachBtn, { borderColor: sepClr, backgroundColor: cardBg }]}>
              <Ionicons name="image-outline" size={20} color={accent} />
              <Text style={[styles.attachBtnText, { color: subText }]}>Add a screenshot</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={submit}
            disabled={!canSubmit}
            activeOpacity={0.85}
            style={[styles.submitBtn, { backgroundColor: canSubmit ? accent : sepClr }]}
          >
            {submitting ? <ActivityIndicator color="#fff" /> : (
              <Text style={[styles.submitText, { color: canSubmit ? "#fff" : subText }]}>
                {isContact ? "Start chat" : "Submit ticket"}
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingTop: 6, paddingBottom: 8, gap: 6 },
  headerBackBtn: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { flex: 1, fontFamily: "Roboto-Bold", fontSize: 22, letterSpacing: -0.3 },
  headerSpacer: { width: 40 },
  scrollContent: { paddingHorizontal: 16, paddingBottom: 40, paddingTop: 6 },
  label: { fontFamily: "Roboto-Medium", fontSize: 13, marginBottom: 8, marginTop: 16, marginLeft: 4 },
  input: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingVertical: 12, fontFamily: "Roboto-Regular", fontSize: 15 },
  textarea: { minHeight: 120, textAlignVertical: "top", paddingTop: 12 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1 },
  chipText: { fontFamily: "Roboto-Medium", fontSize: 13 },
  attachBtn: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderStyle: "dashed", paddingVertical: 16, paddingHorizontal: 14 },
  attachBtnText: { fontFamily: "Roboto-Regular", fontSize: 14 },
  attachPreview: { flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  attachThumb: { width: 44, height: 44, borderRadius: 8 },
  attachName: { flex: 1, fontFamily: "Roboto-Regular", fontSize: 13 },
  attachRemove: { padding: 2 },
  submitBtn: { marginTop: 28, paddingVertical: 15, borderRadius: 14, alignItems: "center" },
  submitText: { fontFamily: "Roboto-SemiBold", fontSize: 16 },
});
