import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';
import CallAvatar from './CallAvatar';
import { gridLayout, MAX_VOICE_TILES } from '../callGridLayout';

/**
 * Roster grid for a GROUP / CONFERENCE call (and the ringing/ended states of a
 * group VIDEO call, where there is no live video yet).
 *
 * Same tile geometry as the live video grid — see src/calls/callGridLayout.js.
 * A voice tile IS a video tile whose camera is off, so both surfaces share one
 * layout: 2 people stack top/bottom, 3 stretches the odd tile across its row,
 * 4+ fills a grid, and anything past the ceiling collapses into a "+N" chip.
 *
 * Each tile shows the participant's avatar, their name, and a status line:
 * "Ringing…", "In call", or "Left". `activeSpeakerId` is whoever the SFU
 * currently hears — their tile gets a green speaking ring, so in a group you can
 * see who is talking.
 *
 * `participants` is the call-machine roster map ({ [id]: { id,name,avatar,joined,left } }),
 * already name-resolved by useCallRoster. YOUR OWN tile is added here (first,
 * like WhatsApp) from `selfName` / `selfAvatar` — the roster only carries other
 * people, but the grid maths counts everyone on the call.
 */
const statusLabel = (p, ringing) => {
  if (p.isSelf) return 'You';
  if (p.left) return 'Left';
  if (p.joined) return 'In call';
  // Conference roster carries the backend's authoritative per-member status
  // (confStatus) — a RINGING/INVITED member shows "Ringing…" even mid-call
  // (e.g. someone re-added by the host), not a blanket "Connecting…".
  if (p.confStatus === 'RINGING' || p.confStatus === 'INVITED') return 'Ringing…';
  return ringing ? 'Ringing…' : 'Connecting…';
};

// Avatars shrink as the grid densifies so a 9-person conference still fits.
const avatarFor = (n) => (n <= 2 ? 104 : n <= 4 ? 78 : n <= 6 ? 62 : 50);

// `onParticipantLongPress(p)` — optional; the conference HOST long-presses a
// tile to get the Remove option (CallOverlay only passes it for the host).
export default function CallParticipantsGrid({
  participants = {},
  ringing = false,
  activeSpeakerId = null,
  onParticipantLongPress = null,
  selfName = 'You',
  selfAvatar = null,
  selfId = null,
  micOn = true,
  showSelf = true,
}) {
  const { theme, isDarkMode } = useTheme();
  const c = theme.colors;
  const onBg = isDarkMode ? '#FFFFFF' : c.primaryTextColor;
  const onBgSoft = isDarkMode ? 'rgba(255,255,255,0.65)' : c.secondaryTextColor;
  // The voice call screen sits on the themed ChatWallpaper (light beige / deep
  // teal doodles), so tiles are a translucent card that reads on BOTH — not the
  // always-dark #1F2C34 the video stage uses over black.
  const tileBg = isDarkMode ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.55)';
  const tileBorder = isDarkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)';

  const others = Object.values(participants).filter((p) => p && p.id);
  // Nobody else on the roster yet — render nothing rather than a lone card of
  // yourself. CallOverlay's title/status line is the whole screen in that gap.
  if (!others.length) return null;
  // Your own tile leads the grid; a caller that renders its own self-view
  // elsewhere can turn it off with showSelf={false}.
  const list = showSelf
    ? [{ id: selfId || 'self', isSelf: true, name: selfName || 'You', avatar: selfAvatar, joined: true }, ...others]
    : others;

  const layout = gridLayout(list.length, MAX_VOICE_TILES);
  const shown = list.slice(0, layout.count);
  const size = avatarFor(layout.count);

  return (
    <View style={styles.grid}>
      {shown.map((p, i) => {
        // Only a LIVE participant can be the speaker — a stale relay for someone
        // who already left must not light their tile up.
        const speaking = !p.isSelf && p.joined && !p.left
          && String(p.id) === String(activeSpeakerId);
        const showPlus = layout.extra > 0 && layout.isLast(i);
        return (
          <View key={p.id} style={[styles.cell, layout.tileStyle(i)]}>
            <TouchableOpacity
              style={[
                styles.tile,
                { backgroundColor: tileBg, borderColor: speaking ? '#00D26A' : tileBorder },
                p.left && styles.leftDim,
              ]}
              activeOpacity={onParticipantLongPress && !p.isSelf ? 0.7 : 1}
              disabled={!onParticipantLongPress || p.isSelf}
              onLongPress={onParticipantLongPress && !p.isSelf
                ? () => onParticipantLongPress(p)
                : undefined}
              delayLongPress={350}
            >
              <CallAvatar uri={p.avatar} name={p.name} id={p.id} size={size} />
              <Text style={[styles.name, { color: onBg }]} numberOfLines={1}>
                {p.name || 'Unknown'}
              </Text>
              {/* Public "@handle" under the name. useCallRoster nulls it out
                  when it would only repeat the name above, so this line never
                  shows the same identity twice. */}
              {p.handle ? (
                <Text style={[styles.handle, { color: onBgSoft }]} numberOfLines={1}>
                  {p.handle}
                </Text>
              ) : null}
              <Text
                style={[styles.status, { color: onBgSoft }, p.joined && !p.isSelf && styles.statusActive]}
                numberOfLines={1}
              >
                {statusLabel(p, ringing)}
              </Text>

              {/* Muted. Your own state comes from the local toggle; a remote
                  member's comes from the server roster (`audioEnabled`), which
                  the backend broadcasts for group calls and conferences alike.
                  A member whose roster entry predates the flag is `undefined`,
                  never false, so an unknown state never shows a false badge. */}
              {(p.isSelf ? micOn === false : p.audioEnabled === false) ? (
                <View style={styles.micBadge}>
                  <Ionicons name="mic-off" size={13} color="#fff" />
                </View>
              ) : null}

              {/* Past the ceiling the remaining people collapse onto the last
                  tile rather than shrinking the whole grid into uselessness. */}
              {showPlus ? (
                <View style={styles.moreChip}>
                  <Text style={styles.moreText}>+{layout.extra}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  // 3pt of padding per cell = a 6pt visual gutter between neighbouring tiles.
  cell: { padding: 3 },
  tile: {
    flex: 1,
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    paddingHorizontal: 8,
  },
  leftDim: { opacity: 0.45 },
  name: {
    fontFamily: 'Roboto-Medium',
    fontSize: 15,
    marginTop: 10,
    maxWidth: '100%',
    textAlign: 'center',
  },
  handle: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 1,
    maxWidth: '100%',
    textAlign: 'center',
  },
  status: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 2,
    maxWidth: '100%',
    textAlign: 'center',
  },
  statusActive: { color: '#00D26A' },
  micBadge: {
    position: 'absolute',
    right: 8,
    bottom: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  moreChip: {
    position: 'absolute',
    right: 8,
    top: 8,
    minWidth: 30,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  moreText: { color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 13 },
});
