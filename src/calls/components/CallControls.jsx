import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { BlurView } from 'expo-blur';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../../contexts/ThemeContext';

/**
 * Bottom control card for an active call — WhatsApp style (two rows inside a
 * large rounded card):
 *
 *   voice → [ Speaker ] [ Video ] [ Mute ]
 *           [  Share  ] [  End  ]
 *   video → [ Flip ] [ Camera ] [ Mute ]
 *           [ Speaker ] [ Share ] [ End ]
 *
 * A translucent chip is the idle state; a filled chip is the toggled-active
 * state (muted, speaker on, camera off, sharing). The red round button always
 * ends the call. Theme-aware: the card blends with the light/dark theme;
 * `forceDark` keeps it light-on-dark when floating over a live video feed
 * (which is always dark) regardless of app theme.
 *
 * Video (on the voice layout) upgrades the call to video for both sides — the
 * card then re-renders in the video layout. Share = screen share; where the
 * engine can't capture, tapping surfaces a clear "not supported" alert.
 */
function CircleButton({ icon, lib = 'ion', label, active, danger, disabled, palette, onPress }) {
  const Icon = lib === 'mci' ? MaterialIcons : Ionicons;
  const bg = danger ? '#EA0038' : active ? palette.activeBg : palette.idleBg;
  let color = danger ? '#ffffff' : active ? palette.activeIcon : palette.idleIcon;
  if (disabled) color = palette.disabledIcon;
  return (
    <View style={styles.btnWrap}>
      <TouchableOpacity
        activeOpacity={disabled ? 1 : 0.8}
        onPress={disabled ? undefined : onPress}
        style={[styles.circle, danger && styles.circleDanger, { backgroundColor: bg }]}
      >
        <Icon name={icon} size={danger ? 30 : 24} color={color} />
      </TouchableOpacity>
      {!!label && (
        <Text style={[styles.label, { color: palette.label }]} numberOfLines={1}>{label}</Text>
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
  // the light wallpaper. The card itself is the WhatsApp bottom-sheet surface.
  const palette = dark
    ? {
      cardBg: 'rgba(17,25,31,0.86)',
      activeBg: '#ffffff',
      activeIcon: '#0B141A',
      idleBg: 'rgba(255,255,255,0.14)',
      idleIcon: '#ffffff',
      disabledIcon: 'rgba(255,255,255,0.4)',
      label: 'rgba(255,255,255,0.85)',
    }
    : {
      cardBg: 'rgba(255,255,255,0.82)',
      activeBg: '#0B141A',
      activeIcon: '#ffffff',
      idleBg: 'rgba(0,0,0,0.07)',
      idleIcon: '#0B141A',
      disabledIcon: 'rgba(11,20,26,0.35)',
      label: 'rgba(11,20,26,0.7)',
    };

  const speakerBtn = (
    <CircleButton
      icon={speakerOn ? 'volume-high' : 'volume-medium'}
      active={speakerOn}
      disabled={!speakerSupported}
      label={speakerSupported ? 'Speaker' : 'Auto'}
      palette={palette}
      onPress={onToggleSpeaker}
    />
  );
  const muteBtn = (
    <CircleButton
      icon={micOn ? 'mic' : 'mic-off'}
      active={!micOn}
      label={micOn ? 'Mute' : 'Unmute'}
      palette={palette}
      onPress={onToggleMic}
    />
  );
  const shareBtn = (
    <CircleButton
      icon={screenSharing ? 'stop-screen-share' : 'screen-share'}
      lib="mci"
      active={screenSharing}
      label={screenSharing ? 'Sharing' : 'Share'}
      palette={palette}
      onPress={onToggleScreenShare}
    />
  );
  const endBtn = (
    <CircleButton icon="call-end" lib="mci" danger label="End" palette={palette} onPress={onHangup} />
  );

  return (
    <BlurView
      intensity={dark ? 30 : 40}
      tint={dark ? 'dark' : 'light'}
      style={[styles.card, { backgroundColor: palette.cardBg }]}
    >
      {isVideo ? (
        <>
          <View style={styles.row}>
            <CircleButton icon="camera-reverse" label="Flip" palette={palette} onPress={onSwitchCamera} />
            <CircleButton
              icon={cameraOn ? 'videocam' : 'videocam-off'}
              active={!cameraOn}
              label={cameraOn ? 'Camera' : 'Camera off'}
              palette={palette}
              onPress={onToggleCamera}
            />
            {muteBtn}
          </View>
          <View style={styles.row}>
            {speakerBtn}
            {shareBtn}
            {endBtn}
          </View>
        </>
      ) : (
        <>
          <View style={styles.row}>
            {speakerBtn}
            {/* Camera ON upgrades the voice call to a video call (WhatsApp
                style — the card then switches to the video layout). */}
            <CircleButton icon="videocam" label="Video" palette={palette} onPress={onToggleCamera} />
            {muteBtn}
          </View>
          <View style={styles.row}>
            {shareBtn}
            {endBtn}
          </View>
        </>
      )}
    </BlurView>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'center',
    borderRadius: 32,
    overflow: 'hidden',
    paddingVertical: 18,
    paddingHorizontal: 14,
    width: '92%',
    maxWidth: 440,
    gap: 18,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    alignItems: 'flex-start',
    width: '100%',
  },
  btnWrap: { alignItems: 'center', flexShrink: 1, minWidth: 84 },
  circle: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
  },
  circleDanger: {
    width: 60, height: 60, borderRadius: 30,
  },
  label: {
    fontFamily: 'Roboto-Regular',
    fontSize: 12,
    marginTop: 8,
  },
});
