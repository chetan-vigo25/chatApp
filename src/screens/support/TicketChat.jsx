import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View, Text, TextInput, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator,
  Image, KeyboardAvoidingView, Platform, Alert, Linking,
} from "react-native";
import { useTheme } from "../../contexts/ThemeContext";
import { Ionicons, FontAwesome6 } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { BACKEND_URL } from "@env";
import { viewTicket, replyTicket, SUPPORT_STATUS_META } from "../../Redux/Services/Support/Support.Services";
import { getSocket } from "../../Redux/Services/Socket/socket";

// Resolve a relative /uploads/* path against the backend origin.
const ORIGIN = (() => {
  try { const m = String(BACKEND_URL || "").match(/^(https?:\/\/[^/]+)/); return m ? m[1] : ""; }
  catch { return ""; }
})();
const resolveUrl = (u) => (!u ? "" : /^https?:\/\//.test(u) ? u : `${ORIGIN}${u.startsWith("/") ? "" : "/"}${u}`);

export default function TicketChat({ navigation, route }) {
  const { ticketId, ticketNumber } = route.params || {};
  const { theme, isDarkMode } = useTheme();
  const accent = theme.colors.themeColor;
  const primaryText = theme.colors.primaryTextColor;
  const subText = theme.colors.secondaryTextColor;
  const pageBg = isDarkMode ? "#000000" : "#ECE5DD";
  const cardBg = isDarkMode ? "#16222C" : "#FFFFFF";
  const adminBubble = isDarkMode ? "#1F2C34" : "#FFFFFF";

  const [ticket, setTicket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(() => {
    viewTicket(ticketId)
      .then((data) => { setTicket(data.ticket); setMessages(data.messages || []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [ticketId]);

  useEffect(() => { load(); }, [load]);

  // Realtime: append admin replies + reflect status changes for this ticket.
  useEffect(() => {
    const socket = getSocket?.();
    if (!socket) return undefined;
    const onNew = (payload) => {
      if (String(payload?.ticketId) !== String(ticketId)) return;
      const m = payload.message;
      if (!m) return;
      setMessages((prev) => (prev.some((x) => String(x._id) === String(m._id)) ? prev : [...prev, m]));
    };
    const onUpdated = (payload) => {
      if (String(payload?.ticketId) !== String(ticketId)) return;
      if (payload.status) setTicket((t) => (t ? { ...t, status: payload.status } : t));
      load();
    };
    socket.on("support:message:new", onNew);
    socket.on("support:ticket:updated", onUpdated);
    return () => { socket.off("support:message:new", onNew); socket.off("support:ticket:updated", onUpdated); };
  }, [ticketId, load]);

  useEffect(() => {
    if (messages.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);
  }, [messages.length]);

  const pickImage = async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) { Alert.alert("Permission needed", "Allow photo access to attach a file."); return; }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
      if (!result.canceled && result.assets?.[0]) {
        const a = result.assets[0];
        setAttachment({ uri: a.uri, name: a.fileName || `file-${Date.now()}.jpg`, type: a.mimeType || "image/jpeg" });
      }
    } catch (e) { Alert.alert("Couldn't open gallery", e?.message || "Please try again."); }
  };

  const send = async () => {
    if ((!text.trim() && !attachment) || sending) return;
    const body = text.trim();
    setSending(true);
    try {
      const msg = await replyTicket({ ticketId, text: body, attachment });
      setText(""); setAttachment(null);
      if (msg) setMessages((prev) => (prev.some((x) => String(x._id) === String(msg._id)) ? prev : [...prev, msg]));
    } catch (err) {
      Alert.alert("Couldn't send", typeof err === "string" ? err : "Please try again.");
    } finally {
      setSending(false);
    }
  };

  const canChat = ticket?.status === "in_progress";
  const statusMeta = SUPPORT_STATUS_META[ticket?.status] || null;
  const lockedMessage =
    ticket?.status === "closed"
      ? "This ticket is closed."
      : ticket?.status === "resolved"
        ? "This ticket has been resolved. Our team will reopen it if you reply via a new request."
        : "Our support team will respond shortly. You'll be able to chat once they pick up your ticket.";

  const renderItem = ({ item }) => {
    if (item.isSystem) {
      return (
        <View style={styles.systemWrap}>
          <Text style={[styles.systemText, { backgroundColor: isDarkMode ? "#1F2C34" : "#FFF6D6", color: subText }]}>{item.text}</Text>
        </View>
      );
    }
    const mine = item.senderRole === "user";
    return (
      <View style={[styles.bubbleRow, { justifyContent: mine ? "flex-end" : "flex-start" }]}>
        <View style={[styles.bubble, mine ? { backgroundColor: isDarkMode ? "#005C4B" : "#D9FDD3" } : { backgroundColor: adminBubble }]}>
          {!mine && <Text style={[styles.senderName, { color: accent }]}>{item.senderName || "Support"}</Text>}
          {item.mediaUrl ? (
            item.mediaType === "image" ? (
              <TouchableOpacity onPress={() => Linking.openURL(resolveUrl(item.mediaUrl))}>
                <Image source={{ uri: resolveUrl(item.mediaUrl) }} style={styles.bubbleImage} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity onPress={() => Linking.openURL(resolveUrl(item.mediaUrl))} style={styles.fileRow}>
                <Ionicons name="document-outline" size={18} color={mine ? primaryText : accent} />
                <Text style={[styles.fileName, { color: primaryText }]} numberOfLines={1}>{item.fileName || "Attachment"}</Text>
              </TouchableOpacity>
            )
          ) : null}
          {item.text ? <Text style={[styles.bubbleText, { color: primaryText }]}>{item.text}</Text> : null}
          <Text style={[styles.time, { color: subText }]}>
            {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </Text>
        </View>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}>
      <View style={[styles.container, { backgroundColor: pageBg }]}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: cardBg }]}>
          <TouchableOpacity onPress={() => navigation.goBack()} activeOpacity={0.6} style={styles.headerBackBtn}>
            <FontAwesome6 name="arrow-left" size={18} color={primaryText} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerTitle, { color: primaryText }]} numberOfLines={1}>
              {ticket?.subject || "Support"}
            </Text>
            <Text style={[styles.headerSub, { color: subText }]} numberOfLines={1}>
              {ticketNumber || ticket?.ticketNumber}{statusMeta ? ` · ${statusMeta.label}` : ""}
            </Text>
          </View>
          {statusMeta && <View style={[styles.headerDot, { backgroundColor: statusMeta.color }]} />}
        </View>

        {loading ? (
          <View style={styles.center}><ActivityIndicator color={accent} /></View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => String(m._id)}
            renderItem={renderItem}
            contentContainerStyle={styles.listContent}
            showsVerticalScrollIndicator={false}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
        )}

        {/* Composer — only while the ticket is In Progress */}
        {!canChat ? (
          <View style={[styles.closedBar, { backgroundColor: cardBg }]}>
            <Text style={[styles.closedText, { color: subText }]}>{lockedMessage}</Text>
          </View>
        ) : (
          <View style={[styles.composer, { backgroundColor: cardBg }]}>
            {attachment && (
              <View style={styles.attachRow}>
                <Image source={{ uri: attachment.uri }} style={styles.attachThumb} />
                <Text numberOfLines={1} style={[styles.attachName, { color: subText }]}>{attachment.name}</Text>
                <TouchableOpacity onPress={() => setAttachment(null)}><Ionicons name="close-circle" size={20} color={subText} /></TouchableOpacity>
              </View>
            )}
            <View style={styles.composerRow}>
              <TouchableOpacity onPress={pickImage} style={styles.attachBtn}>
                <Ionicons name="attach" size={24} color={subText} />
              </TouchableOpacity>
              <TextInput
                value={text}
                onChangeText={setText}
                placeholder="Type a message…"
                placeholderTextColor={subText}
                multiline
                style={[styles.input, { color: primaryText, backgroundColor: isDarkMode ? "#0B141A" : "#F0F2F5" }]}
              />
              <TouchableOpacity
                onPress={send}
                disabled={(!text.trim() && !attachment) || sending}
                style={[styles.sendBtn, { backgroundColor: accent, opacity: (!text.trim() && !attachment) || sending ? 0.6 : 1 }]}
              >
                {sending ? <ActivityIndicator size="small" color="#fff" /> : <Ionicons name="send" size={18} color="#fff" />}
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", paddingHorizontal: 10, paddingTop: 8, paddingBottom: 10, gap: 8 },
  headerBackBtn: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  headerTitle: { fontFamily: "Roboto-SemiBold", fontSize: 16 },
  headerSub: { fontFamily: "Roboto-Regular", fontSize: 12, marginTop: 1 },
  headerDot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  listContent: { padding: 12, paddingBottom: 16 },
  bubbleRow: { flexDirection: "row", marginBottom: 8 },
  bubble: { maxWidth: "82%", borderRadius: 12, paddingHorizontal: 10, paddingVertical: 7 },
  senderName: { fontFamily: "Roboto-SemiBold", fontSize: 12, marginBottom: 2 },
  bubbleText: { fontFamily: "Roboto-Regular", fontSize: 15, lineHeight: 20 },
  bubbleImage: { width: 200, height: 200, borderRadius: 8, marginBottom: 4 },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 4, marginBottom: 2 },
  fileName: { fontFamily: "Roboto-Medium", fontSize: 13, maxWidth: 180 },
  time: { fontFamily: "Roboto-Regular", fontSize: 10, alignSelf: "flex-end", marginTop: 2 },
  systemWrap: { alignItems: "center", marginVertical: 8 },
  systemText: { fontFamily: "Roboto-Regular", fontSize: 12, paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10, overflow: "hidden" },
  composer: { paddingHorizontal: 8, paddingTop: 6, paddingBottom: Platform.OS === "ios" ? 22 : 8 },
  attachRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 8, paddingVertical: 6 },
  attachThumb: { width: 36, height: 36, borderRadius: 6 },
  attachName: { flex: 1, fontFamily: "Roboto-Regular", fontSize: 12 },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 6 },
  attachBtn: { width: 40, height: 44, alignItems: "center", justifyContent: "center" },
  input: { flex: 1, maxHeight: 110, minHeight: 44, borderRadius: 22, paddingHorizontal: 16, paddingTop: 11, paddingBottom: 11, fontFamily: "Roboto-Regular", fontSize: 15 },
  sendBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  closedBar: { padding: 16, alignItems: "center" },
  closedText: { fontFamily: "Roboto-Regular", fontSize: 13 },
});
