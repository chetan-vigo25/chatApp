// "Business details" block of a business's Contact info (docs/BUSINESS_CHAT_README.md
// §2.5 / §3.7). Data = `profile.business` from user/auth/view, read when the
// screen opens and never persisted. A row only when it has a value; the
// "Verified" chip comes from the server's `websiteVerified` — never derived here.
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import moment from 'moment';

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

const withScheme = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

function DetailRow({ icon, value, label, onPress, primary, sub, accent, chip }) {
  const body = (
    <View style={styles.row}>
      <Ionicons name={icon} size={20} color={accent} style={styles.rowIcon} />
      <View style={styles.rowText}>
        <View style={styles.valueLine}>
          <Text style={[styles.value, { color: onPress ? accent : primary }]} numberOfLines={3}>{value}</Text>
          {chip}
        </View>
        <Text style={[styles.label, { color: sub }]}>{label}</Text>
      </View>
    </View>
  );
  if (!onPress) return body;
  return (
    <TouchableOpacity activeOpacity={0.6} onPress={onPress} accessibilityRole="link">
      {body}
    </TouchableOpacity>
  );
}

export default function BusinessDetailsCard({
  business, cardBg, primaryText, subText, accent, dividerColor,
}) {
  const b = business || {};
  const category = clean(b.category);
  const website = clean(b.website);
  const email = clean(b.email);
  const phone = clean(b.phone);
  const address = clean(b.address);
  const since = b.memberSince && moment(b.memberSince).isValid()
    ? moment(b.memberSince).format('MMMM YYYY')
    : '';

  const rows = [];
  if (category) {
    rows.push(<DetailRow key="category" icon="pricetag-outline" value={category} label="Category" />);
  }
  if (website) {
    rows.push(
      <DetailRow
        key="website"
        icon="globe-outline"
        value={website.replace(/^https?:\/\//i, '').replace(/\/$/, '')}
        label="Website"
        onPress={() => Linking.openURL(withScheme(website)).catch(() => {})}
        chip={b.websiteVerified === true ? (
          <View style={styles.chip}>
            <Ionicons name="checkmark-circle" size={12} color="#1E8E3E" />
            <Text style={styles.chipText}>Verified</Text>
          </View>
        ) : null}
      />,
    );
  }
  if (email) {
    rows.push(
      <DetailRow
        key="email"
        icon="mail-outline"
        value={email}
        label="Email"
        onPress={() => Linking.openURL(`mailto:${email}`).catch(() => {})}
      />,
    );
  }
  if (phone) {
    rows.push(
      <DetailRow
        key="phone"
        icon="call-outline"
        value={phone}
        label="Phone"
        onPress={() => Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`).catch(() => {})}
      />,
    );
  }
  if (address) {
    rows.push(<DetailRow key="address" icon="location-outline" value={address} label="Address" />);
  }
  if (since) {
    rows.push(<DetailRow key="since" icon="calendar-outline" value={`On TalksTry since ${since}`} label="Member since" />);
  }

  return (
    <View style={[styles.card, { backgroundColor: cardBg }]}>
      <Text style={[styles.title, { color: subText }]}>Business details</Text>
      {rows.length ? rows.map((row, i) => (
        <React.Fragment key={row.key}>
          {i > 0 ? <View style={[styles.divider, { backgroundColor: dividerColor }]} /> : null}
          {React.cloneElement(row, { primary: primaryText, sub: subText, accent })}
        </React.Fragment>
      )) : (
        <Text style={[styles.empty, { color: subText }]}>This business has not shared more details.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Same card shape as the rest of Contact info (UserB styles.card).
  card: {
    marginHorizontal: 10,
    marginTop: 12,
    borderRadius: 14,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.18)',
    paddingVertical: 6,
  },
  title: {
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
    fontSize: 13,
    fontFamily: 'Roboto-Medium',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowIcon: { marginTop: 2, marginRight: 14 },
  rowText: { flex: 1 },
  valueLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  value: { fontSize: 15, fontFamily: 'Roboto-Regular', flexShrink: 1 },
  label: { marginTop: 2, fontSize: 12, fontFamily: 'Roboto-Regular' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginLeft: 8,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: 'rgba(30,142,62,0.12)',
  },
  chipText: {
    marginLeft: 3,
    color: '#1E8E3E',
    fontSize: 11,
    fontFamily: 'Roboto-Medium',
  },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 50 },
  empty: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 14,
    fontFamily: 'Roboto-Regular',
  },
});
