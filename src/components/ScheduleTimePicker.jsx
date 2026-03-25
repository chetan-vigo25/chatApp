import React, { useState, useMemo, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, Modal, StyleSheet, ScrollView, Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';

// 12-hour format data
const HOURS_12 = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

const pad = (n) => String(n).padStart(2, '0');

export default function ScheduleTimePicker({ visible, onClose, onSchedule, theme }) {
  const now = new Date();
  const currentHour = now.getHours();
  const [selectedDay, setSelectedDay] = useState(0);
  // Store in 12h format internally
  const [selectedHour, setSelectedHour] = useState(currentHour % 12 || 12);
  const [selectedMinute, setSelectedMinute] = useState(Math.ceil(now.getMinutes() / 5) * 5 % 60);
  const [selectedPeriod, setSelectedPeriod] = useState(currentHour >= 12 ? 'PM' : 'AM');

  const days = useMemo(() => {
    const result = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      result.push({
        index: i,
        label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : d.toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' }),
        date: d,
      });
    }
    return result;
  }, []);

  // Convert 12h to 24h for scheduling
  const get24Hour = () => {
    let h24 = selectedHour;
    if (selectedPeriod === 'AM') {
      if (h24 === 12) h24 = 0;
    } else {
      if (h24 !== 12) h24 += 12;
    }
    return h24;
  };

  const isValidTime = useMemo(() => {
    const scheduled = new Date(days[selectedDay].date);
    const h24 = selectedPeriod === 'AM' ? (selectedHour === 12 ? 0 : selectedHour) : (selectedHour === 12 ? 12 : selectedHour + 12);
    scheduled.setHours(h24, selectedMinute, 0, 0);
    return scheduled.getTime() > Date.now() + 60000;
  }, [selectedDay, selectedHour, selectedMinute, selectedPeriod, days]);

  const handleConfirm = useCallback(() => {
    const scheduled = new Date(days[selectedDay].date);
    const h24 = get24Hour();
    scheduled.setHours(h24, selectedMinute, 0, 0);
    onSchedule(scheduled.toISOString());
    onClose();
  }, [selectedDay, selectedHour, selectedMinute, selectedPeriod, days, onSchedule, onClose]);

  if (!visible) return null;

  const bg = theme?.colors?.cardBackground || '#1F2C34';
  const textColor = theme?.colors?.primaryTextColor || '#E9EDEF';
  const subColor = theme?.colors?.placeHolderTextColor || '#8696A0';
  const accent = theme?.colors?.themeColor || '#00A884';

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity activeOpacity={1} onPress={onClose} style={styles.overlay}>
        <TouchableOpacity activeOpacity={1} style={[styles.container, { backgroundColor: bg }]}>
          {/* Header */}
          <View style={styles.header}>
            <Ionicons name="time-outline" size={22} color={accent} />
            <Text style={[styles.title, { color: textColor }]}>Schedule Message</Text>
          </View>

          {/* Day selector */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.dayScroll}>
            {days.map((day) => (
              <TouchableOpacity
                key={day.index}
                onPress={() => setSelectedDay(day.index)}
                style={[
                  styles.dayChip,
                  selectedDay === day.index ? { backgroundColor: accent } : { backgroundColor: accent + '15' },
                ]}
              >
                <Text style={[
                  styles.dayText,
                  { color: selectedDay === day.index ? '#fff' : accent },
                ]}>{day.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Time picker — 12h format */}
          <View style={styles.timeRow}>
            {/* Hour (1-12) */}
            <View style={styles.timeCol}>
              <Text style={[styles.timeLabel, { color: subColor }]}>Hour</Text>
              <ScrollView style={styles.timeScroll} showsVerticalScrollIndicator={false}>
                {HOURS_12.map((h) => (
                  <TouchableOpacity
                    key={h}
                    onPress={() => setSelectedHour(h)}
                    style={[styles.timeItem, selectedHour === h && { backgroundColor: accent + '20' }]}
                  >
                    <Text style={[
                      styles.timeItemText,
                      { color: selectedHour === h ? accent : textColor },
                      selectedHour === h && { fontFamily: 'Roboto-SemiBold' },
                    ]}>{h}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <Text style={[styles.timeSeparator, { color: textColor }]}>:</Text>

            {/* Minute */}
            <View style={styles.timeCol}>
              <Text style={[styles.timeLabel, { color: subColor }]}>Min</Text>
              <ScrollView style={styles.timeScroll} showsVerticalScrollIndicator={false}>
                {MINUTES.map((m) => (
                  <TouchableOpacity
                    key={m}
                    onPress={() => setSelectedMinute(m)}
                    style={[styles.timeItem, selectedMinute === m && { backgroundColor: accent + '20' }]}
                  >
                    <Text style={[
                      styles.timeItemText,
                      { color: selectedMinute === m ? accent : textColor },
                      selectedMinute === m && { fontFamily: 'Roboto-SemiBold' },
                    ]}>{pad(m)}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            {/* AM/PM */}
            <View style={[styles.timeCol, { width: 60 }]}>
              <Text style={[styles.timeLabel, { color: subColor }]}>{' '}</Text>
              <View style={styles.periodWrap}>
                {['AM', 'PM'].map((p) => (
                  <TouchableOpacity
                    key={p}
                    onPress={() => setSelectedPeriod(p)}
                    style={[
                      styles.periodBtn,
                      selectedPeriod === p ? { backgroundColor: accent } : { backgroundColor: accent + '15' },
                    ]}
                  >
                    <Text style={[
                      styles.periodText,
                      { color: selectedPeriod === p ? '#fff' : accent },
                    ]}>{p}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          </View>

          {/* Preview */}
          <Text style={[styles.preview, { color: subColor }]}>
            {days[selectedDay].label} at {selectedHour}:{pad(selectedMinute)} {selectedPeriod}
          </Text>

          {/* Actions */}
          <View style={styles.actions}>
            <TouchableOpacity onPress={onClose} style={styles.cancelBtn}>
              <Text style={[styles.cancelText, { color: subColor }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleConfirm}
              disabled={!isValidTime}
              style={[styles.confirmBtn, { backgroundColor: isValidTime ? accent : accent + '40' }]}
            >
              <Ionicons name="time-outline" size={16} color="#fff" style={{ marginRight: 6 }} />
              <Text style={styles.confirmText}>Schedule</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  container: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingTop: 20, paddingBottom: Platform.OS === 'ios' ? 44 : 40,
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16,
  },
  title: { fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  dayScroll: { marginBottom: 16, flexGrow: 0 },
  dayChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18, marginRight: 8,
  },
  dayText: { fontFamily: 'Roboto-Medium', fontSize: 13 },
  timeRow: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center',
    marginBottom: 12,
  },
  timeCol: { alignItems: 'center', width: 70 },
  timeLabel: { fontFamily: 'Roboto-Medium', fontSize: 11, marginBottom: 6, textTransform: 'uppercase' },
  timeScroll: { height: 150 },
  timeItem: {
    paddingVertical: 8, paddingHorizontal: 14, borderRadius: 8, marginVertical: 1,
  },
  timeItemText: { fontFamily: 'Roboto-Regular', fontSize: 16, textAlign: 'center' },
  timeSeparator: { fontFamily: 'Roboto-SemiBold', fontSize: 24, marginHorizontal: 6, marginTop: 26 },
  periodWrap: { gap: 6, marginTop: 8 },
  periodBtn: {
    paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center',
  },
  periodText: { fontFamily: 'Roboto-SemiBold', fontSize: 14 },
  preview: { fontFamily: 'Roboto-Medium', fontSize: 13, textAlign: 'center', marginBottom: 16 },
  actions: {
    flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 4,
  },
  cancelBtn: { paddingVertical: 12, paddingHorizontal: 20 },
  cancelText: { fontFamily: 'Roboto-Medium', fontSize: 15 },
  confirmBtn: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 12, paddingHorizontal: 24, borderRadius: 24,
    elevation: 3,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4,
  },
  confirmText: { fontFamily: 'Roboto-SemiBold', fontSize: 15, color: '#fff' },
});
