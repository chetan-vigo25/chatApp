import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * Bottom control bar for an active call — WhatsApp style.
 *
 * Buttons sit inside a frosted, rounded pill. A translucent button is the
 * default/"on" state; a filled button is the toggled-active state (muted,
 * speaker on, camera off). The red round button always ends the call.
 *
 * Theme-aware: on the opaque (audio) call screen the pill blends with the
 * current light/dark theme. `forceDark` keeps it light-on-dark when it floats
 * over a live video feed (which is always dark), regardless of app theme.
 *
 * Layout (matches WhatsApp):
 *   voice call → [ Speaker ] [ Video ] [ Share ] [ Mute ] [ End ]
 *   video call → [ Flip ] [ Camera ] [ Share ] [ Speaker ] [ Mute ] [ End ]
 *
 * Video (voice bar) turns the camera on mid-call, upgrading the voice call to a
 * video call for both sides — the bar then re-renders in the video layout.
 *
 * Speaker toggles the audio route: ON = loudspeaker (loud), OFF = earpiece
 * (normal, follows the device volume) — same on both call types.
 *
 * Share = screen share. Availability depends on the WebView exposing
 * getDisplayMedia — where it doesn't, tapping shows a clear "not supported"
 * alert (the engine reports it); RECEIVING a peer's shared screen always works.
 */
function CircleButton({ icon, lib = 'ion', label, active, danger, disabled, small, palette, onPress }) {
  const Icon = lib === 'mci' ? MaterialIcons : Ionicons;
  const bg = danger ? '#EA0038' : active ? palette.activeBg : palette.idleBg;
  let color = danger ? '#ffffff' : active ? palette.activeIcon : palette.idleIcon;
  if (disabled) color = palette.disabledIcon;
  const size = danger ? 32 : small ? 22 : 25;
  return (
    <View style={styles.btnWrap}>
      <TouchableOpacity
        activeOpacity={disabled ? 1 : 0.8}
        onPress={disabled ? undefined : onPress}
        style={[styles.circle, small && styles.circleSmall, danger && styles.circleDanger, { backgroundColor: bg }]}
      >
        <Icon name={icon} size={size} color={color} />
      </TouchableOpacity>
      {!!label && (
        <Text style={[styles.label, { color: palette.label }]}>{label}</Text>
      )}
    </View>
  );
}

export default function CallControls({
  isVideo,
  forceDark = false,
  micOn,
  cameraOn,
  screenSharing = false,
  speakerOn,
  speakerSupported = true,
  onToggleMic,
  onToggleCamera,
  onSwitchCamera,
  onToggleScreenShare,
  onToggleSpeaker,
  onHangup,
}) {
  const { isDarkMode } = useTheme();
  const dark = forceDark || isDarkMode;

  // A toggled-on button is a high-contrast filled chip; an idle button is a
  // translucent chip. Light theme flips the contrast so icons stay legible on
  // the light wallpaper.
  const palette = dark
    ? {
      activeBg: '#ffffff',
      activeIcon: '#0B141A',
      idleBg: 'rgba(255,255,255,0.18)',
      idleIcon: '#ffffff',
      disabledIcon: 'rgba(255,255,255,0.4)',
      label: 'rgba(255,255,255,0.85)',
    }
    : {
      activeBg: '#0B141A',
      activeIcon: '#ffffff',
      idleBg: 'rgba(0,0,0,0.07)',
      idleIcon: '#0B141A',
      disabledIcon: 'rgba(11,20,26,0.35)',
      label: 'rgba(11,20,26,0.7)',
    };

  return (
    <BlurView intensity={dark ? 32 : 40} tint={dark ? 'dark' : 'light'} style={styles.bar}>
      <View style={styles.row}>
        {isVideo ? (
          <>
            <CircleButton
              icon="camera-reverse"
              label="Flip"
              small
              palette={palette}
              onPress={onSwitchCamera}
            />
            <CircleButton
              icon={cameraOn ? 'videocam' : 'videocam-off'}
              active={!cameraOn}
              label={cameraOn ? 'Camera' : 'Camera off'}
              small
              palette={palette}
              onPress={onToggleCamera}
            />
            {/* Screen share — temporarily disabled (per request). Re-enable by
                uncommenting; the engine/handler wiring is untouched.
            <CircleButton
              icon={screenSharing ? 'stop-screen-share' : 'screen-share'}
              lib="mci"
              active={screenSharing}
              label={screenSharing ? 'Sharing' : 'Share'}
              small
              palette={palette}
              onPress={onToggleScreenShare}
            />
            */}
            <CircleButton
              icon={speakerOn ? 'volume-high' : 'volume-medium'}
              active={speakerOn}
              disabled={!speakerSupported}
              label={speakerSupported ? 'Speaker' : 'Auto'}
              small
              palette={palette}
              onPress={onToggleSpeaker}
            />
          </>
        ) : (
          <>
            <CircleButton
              icon={speakerOn ? 'volume-high' : 'volume-medium'}
              active={speakerOn}
              disabled={!speakerSupported}
              label={speakerSupported ? 'Speaker' : 'Auto'}
              small
              palette={palette}
              onPress={onToggleSpeaker}
            />
            {/* Camera ON upgrades the voice call to a video call (WhatsApp style —
                the bar then switches to the video layout). */}
            <CircleButton
              icon="videocam"
              label="Video"
              small
              palette={palette}
              onPress={onToggleCamera}
            />
            {/* Screen share — temporarily disabled (per request). Re-enable by
                uncommenting; the engine/handler wiring is untouched.
            <CircleButton
              icon={screenSharing ? 'stop-screen-share' : 'screen-share'}
              lib="mci"
              active={screenSharing}
              label={screenSharing ? 'Sharing' : 'Share'}
              small
              palette={palette}
              onPress={onToggleScreenShare}
            />
            */}
          </>
        )}

        <CircleButton
          icon={micOn ? 'mic' : 'mic-off'}
          active={!micOn}
          label={micOn ? 'Mute' : 'Unmute'}
          small
          palette={palette}
          onPress={onToggleMic}
        />

        <CircleButton
          icon="call-end"
          lib="mci"
          danger
          label="End"
          palette={palette}
          onPress={onHangup}
        />
      </View>
    </BlurView>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'center',
    borderRadius: 36,
    overflow: 'hidden',
    paddingVertical: 16,
    paddingHorizontal: 8,
    width: '92%',
    maxWidth: 440,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'flex-end',
    width: '100%',
  },
  // Sized so the 6-button video bar (Flip · Camera · Share · Speaker · Mute ·
  // End) fits even on narrow (~320dp) screens without clipping (`circleSmall`);
  // the 3-button voice bar keeps the roomier 54dp circles.
  btnWrap: { alignItems: 'center', flexShrink: 1 },
  circle: {
    width: 54, height: 54, borderRadius: 27,
    alignItems: 'center', justifyContent: 'center',
  },
  circleSmall: {
    width: 46, height: 46, borderRadius: 23,
  },
  circleDanger: {
    width: 58, height: 58, borderRadius: 29,
  },
  label: {
    fontFamily: 'Roboto-Regular',
    fontSize: 11.5,
    marginTop: 8,
  },
});
