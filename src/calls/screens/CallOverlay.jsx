import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, BackHandler, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useCall } from '../useCall';
import { useTheme } from '../../contexts/ThemeContext';
import useContactDirectory from '../../hooks/useContactDirectory';
import { navigateToChat } from '../../Redux/Services/navigationService';
import { CALL_STATUS, joinedCount } from '../state/callMachine';
import ChatWallpaper from '../../components/ChatWallpaper';
import CallAvatar from '../components/CallAvatar';
import CallControls from '../components/CallControls';
import CallTimer from '../components/CallTimer';
import IncomingCallCard from '../components/IncomingCallCard';
import CallParticipantsGrid from '../components/CallParticipantsGrid';
import PulsingRing from '../components/PulsingRing';
import CallMiniBanner from '../components/CallMiniBanner';
import AddParticipantSheet from '../components/AddParticipantSheet';

const END_TEXT = {
  completed: 'Call ended',
  rejected: 'Call declined',
  cancelled: 'Call cancelled',
  missed: 'Missed call',
  failed: 'Call failed',
  busy: 'User is busy on another call',
};

export default function CallOverlay() {
  const {
    call, accept, reject, hangup,
    toggleMic, toggleCamera, switchCamera, toggleScreenShare, toggleSpeaker, resumeAudio,
    minimize, maximize,
    inviteMoreToCall,
    audioRouteSupported,
    lockedCall, leaveToLock,
  } = useCall();

  // Mid-call "Add participant" member picker (group calls).
  const [showAddSheet, setShowAddSheet] = useState(false);

  const insets = useSafeAreaInsets();
  const { theme, isDarkMode } = useTheme();
  // Resolve the caller/callee name to the device's saved contact name (then
  // mobile number, then backend name) — same priority as the chat list.
  const { resolveName } = useContactDirectory();
  const c = theme.colors;
  // Palette for the opaque (audio / incoming / outgoing / ended) call screen,
  // which now sits on the WhatsApp chat wallpaper — so text/icons must read on a
  // light beige (light mode) or deep teal (dark mode) doodle background.
  const onBg = isDarkMode ? '#FFFFFF' : c.primaryTextColor;        // primary text
  const onBgSoft = isDarkMode ? 'rgba(255,255,255,0.75)' : c.secondaryTextColor; // secondary
  const ringColor = isDarkMode ? 'rgba(255,255,255,0.16)' : 'rgba(3,176,162,0.18)';
  const avatarBorder = isDarkMode ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.10)';
  const minBtnBg = isDarkMode ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.06)';
  const minBtnIcon = isDarkMode ? '#FFFFFF' : c.iconColor;
  // Matches the ChatWallpaper base so there's no flash before the SVG paints.
  const screenBg = isDarkMode ? '#0B141A' : '#EAE1D6';
  const status = call?.status || CALL_STATUS.IDLE;
  const visible = status !== CALL_STATUS.IDLE;
  const isVideo = call?.media === 'video';
  const accepted0 = !!call?.accepted;
  // Show the camera/video stage (transparent layer over the WebView) whenever we
  // have local camera media to show: the CALLER while ringing (OUTGOING), and once
  // answered (accepted / ACTIVE). Incoming-not-yet-accepted stays on the opaque
  // ring screen (Accept/Decline) — the callee's camera only starts on accept.
  const isVideoActive = isVideo && (
    status === CALL_STATUS.ACTIVE
    || status === CALL_STATUS.OUTGOING
    || (status === CALL_STATUS.INCOMING && accepted0)
  );
  const isGroup = !!call?.isGroup;
  const accepted = !!call?.accepted; // callee tapped Accept / caller got the accept signal — media may still be connecting
  // "Connected" for the UI means REAL remote media is flowing — status === ACTIVE,
  // which is driven ONLY by the SDK's remote-media `stream` (ontrack) event, never
  // by the accept signal. `connecting` is the answered-but-not-yet-connected gap
  // (accept signal received, no remote media yet): we show "Connecting…" then, so
  // the screen never claims "connected"/shows a running timer before media exists.
  // The post-answer connect watchdog (CallProvider) ends this gap as "Couldn't
  // connect" if media never arrives (e.g. the callee accepted then lost internet).
  const mediaConnected = status === CALL_STATUS.ACTIVE;
  const connecting = accepted
    && status !== CALL_STATUS.ACTIVE
    && status !== CALL_STATUS.ENDED;
  // WhatsApp UX: the TIMER shows the moment either side answers (answeredAt is
  // stamped at accept on both sides), not only when remote media lands — the
  // accepted→media gap no longer flashes "Connecting…" at the user. This is a
  // PRESENTATION change only: the state machine stays media-driven (ACTIVE =
  // real media, per the media-driven rule), the 30s connect watchdog still
  // fails the call honestly if media never arrives, and a mid-call drop still
  // replaces the timer with "Reconnecting…".
  const timerRunning = (mediaConnected || (accepted && !!call?.answeredAt))
    && status !== CALL_STATUS.ENDED
    && !call?.reconnecting;
  // Show the incoming Accept/Decline card only until the user answers.
  const showIncomingActions = status === CALL_STATUS.INCOMING && !accepted;
  // A ring pulse while genuinely ringing (stops once either side has answered).
  const ringing = !accepted && (status === CALL_STATUS.OUTGOING || status === CALL_STATUS.INCOMING);
  // An end button is needed while dialing out and while connecting after accept.
  const showEndButton = status === CALL_STATUS.OUTGOING
    || (status === CALL_STATUS.INCOMING && accepted);

  const minimized = !!call?.minimized;

  // What the group roster grid actually SHOWS:
  //  • receiver, once answered → ONLY people actually connected (no own tile,
  //    no "Connecting…" ghosts for members who never picked up);
  //  • caller (and the pre-answer incoming ring) → the invited roster, with
  //    "Ringing…" until each member joins — the ring-window sweep removes
  //    non-answerers so nothing rings forever.
  // Names are resolved through the device contact directory (roster entries
  // from the socket payload only carry ids).
  const gridParticipants = (() => {
    if (!isGroup) return call?.participants || {};
    const all = call?.participants || {};
    const receiverConnectedOnly = call?.direction === 'incoming'
      && (accepted0 || status === CALL_STATUS.ACTIVE);
    const out = {};
    Object.values(all).forEach((p) => {
      if (!p || !p.id) return;
      if (receiverConnectedOnly && !p.joined) return;
      const generic = !p.name || p.name === 'Member' || p.name === 'Unknown';
      const name = generic ? (resolveName(p.id, p.name, null) || p.name || 'Member') : p.name;
      out[p.id] = name === p.name ? p : { ...p, name };
    });
    return out;
  })();

  // "Add participant" is available on a LIVE group call (host ringing included —
  // the host is already in the room while others ring).
  const canAddParticipants = isGroup
    && (status === CALL_STATUS.ACTIVE || accepted || status === CALL_STATUS.OUTGOING);
  const addSheet = canAddParticipants ? (
    <AddParticipantSheet
      visible={showAddSheet}
      onClose={() => setShowAddSheet(false)}
      groupId={call?.groupId}
      // Live roster only (joined or still ringing) — NOT the original invite
      // list, so a member who declined/missed/dropped can be re-added.
      existingIds={Object.keys(call?.participants || {})}
      onInvite={(members) => inviteMoreToCall?.(members)}
    />
  ) : null;
  // The minimize affordance shows once a call is connecting/active or dialing
  // out (same gate as the controls) — NOT on an unanswered incoming ring, which
  // stays full-screen with Accept/Decline like WhatsApp.
  // Minimizing reveals the app behind the call — forbidden when the call arrived on
  // a LOCKED device (it would expose the app over the keyguard). No minimize then;
  // leaving the call returns to the lock screen.
  const canMinimize = (status === CALL_STATUS.ACTIVE || accepted || status === CALL_STATUS.OUTGOING)
    && !lockedCall;

  // An unanswered incoming call first rings as the compact top heads-up banner
  // (IncomingCallBanner) so the user can keep using the app — WhatsApp-style.
  // Stay hidden until they tap it to expand (incomingExpanded) or answer it
  // (accepted0 → the connecting screen below). Suppressing the full-screen ring
  // here is what lets the banner show in its place. A call that lived its whole
  // life as the banner (never expanded, never answered) also skips the terminal
  // full-screen "Call declined"/"Missed" flash on ENDED — it just dismisses.
  const ranAsBannerOnly = call?.direction === 'incoming' && !accepted0 && !call?.incomingExpanded;
  const incomingCollapsed = ranAsBannerOnly
    && (status === CALL_STATUS.INCOMING || status === CALL_STATUS.ENDED);

  // Android hardware back while a call is FULL-SCREEN must NOT end the call
  // (WhatsApp behaviour): instead it MINIMIZES the call to the floating banner/
  // PiP so the user can keep browsing the app, call still running. On an
  // unanswered incoming ring (no minimize affordance yet) back is swallowed so
  // it can't accidentally decline the call either. When already minimized the
  // overlay isn't full-screen, so back works normally for the app behind it.
  // (iOS has no hardware back, and the call UI is an overlay — not a navigation
  // screen — so the swipe-back gesture can never reach or dismiss it.)
  useEffect(() => {
    // While only the compact banner is up (collapsed incoming) the overlay isn't
    // full-screen, so back must work normally for the app behind it.
    if (!visible || minimized || incomingCollapsed) return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Call arrived on a locked device → back returns to the system lock screen,
      // never the app (the call keeps running; the ongoing notification brings it back).
      if (lockedCall) { leaveToLock(); return true; }
      if (canMinimize) minimize();
      // else: unanswered incoming ring (expanded) — consume back, keep ringing.
      return true;
    });
    return () => sub.remove();
  }, [visible, minimized, incomingCollapsed, canMinimize, minimize, lockedCall, leaveToLock]);

  // A short haptic when an incoming call appears (in addition to the ringtone +
  // vibration loop) so the device "kicks" the moment the screen comes up.
  useEffect(() => {
    if (status === CALL_STATUS.INCOMING) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
  }, [status]);

  if (!visible || incomingCollapsed) return null;

  const peer = call?.peer || {};
  // Saved contact name > mobile number > backend name.
  const peerDisplayName = resolveName(peer?.id, peer?.name, peer?.mobile || peer?.phone || peer?.mobileNumber) || peer?.name || 'Unknown';
  const joined = isGroup ? joinedCount(call?.participants) : 0;
  const groupTitle = call?.groupName
    || (isGroup ? `Group ${isVideo ? 'video ' : ''}call` : peerDisplayName);

  const subtitle = (() => {
    // Mid-call network drop (APP-6): while the media layer is re-establishing,
    // surface "Reconnecting…" over the normal timer/status until it recovers.
    if (call?.reconnecting && status !== CALL_STATUS.ENDED && call?.answeredAt) {
      return 'Reconnecting…';
    }
    // Answered but remote media hasn't arrived: the running TIMER (timerRunning)
    // covers this gap now — "Connecting…" only remains as a defensive fallback
    // for an accepted call that somehow has no answeredAt to count from. A call
    // that never connects still fails via the connect watchdog.
    if (connecting && !timerRunning) return 'Connecting…';
    if (status === CALL_STATUS.OUTGOING) {
      if (isGroup) return call?.callId ? 'Ringing…' : 'Calling group…';
      return call?.callId ? 'Ringing…' : 'Calling…';
    }
    if (status === CALL_STATUS.INCOMING) {
      if (isGroup) return `Incoming group ${isVideo ? 'video' : 'voice'} call`;
      return isVideo ? 'Incoming video call' : 'Incoming voice call';
    }
    if (status === CALL_STATUS.ACTIVE && isGroup) {
      return `${joined + 1} in call`;
    }
    // A specific server/engine message (e.g. "User is unavailable right now.")
    // wins over the generic per-reason label.
    if (status === CALL_STATUS.ENDED) return call?.errorMessage || END_TEXT[call?.endReason] || 'Call ended';
    return null;
  })();

  // ---- Minimized: WhatsApp-style floating call window ----
  // A still-live minimized VIDEO call shows its video feed in the draggable
  // engine PiP rendered by CallProvider, so there's nothing to draw here. Voice
  // calls (and a video call that just ended) show the WhatsApp-style top banner.
  if (minimized) {
    if (isVideo && status !== CALL_STATUS.ENDED) return null;
    return (
      <CallMiniBanner
        peer={peer}
        displayName={peerDisplayName}
        isGroup={isGroup}
        groupName={call?.groupName}
        media={call?.media}
        statusText={subtitle || ''}
        showTimer={timerRunning}
        answeredAt={call?.answeredAt}
        micOn={call?.micOn}
        onToggleMic={toggleMic}
        onExpand={maximize}
        onHangup={hangup}
      />
    );
  }

  // ---- Video active: transparent overlay over the WebView video stage ----
  if (isVideoActive) {
    return (
      <View style={styles.videoRoot} pointerEvents="box-none">
        <StatusBar barStyle="light-content" />
        <View style={[styles.videoTopBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          {canMinimize ? (
            <TouchableOpacity
              onPress={minimize}
              style={styles.minBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="chevron-down" size={26} color="#fff" />
            </TouchableOpacity>
          ) : null}
          <View style={styles.videoTitleCol}>
            <Text style={styles.videoName} numberOfLines={1}>{groupTitle}</Text>
            {isGroup ? (
              <Text style={styles.videoSub}>{joined + 1} in call</Text>
            ) : timerRunning ? (
              <CallTimer startMs={call?.answeredAt} />
            ) : (
              <Text style={styles.videoSub}>{subtitle}</Text>
            )}
          </View>
          {canAddParticipants ? (
            <TouchableOpacity
              onPress={() => setShowAddSheet(true)}
              style={styles.minBtn}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="person-add" size={22} color="#fff" />
            </TouchableOpacity>
          ) : null}
        </View>

        {call?.needsUnmuteGesture ? (
          <TouchableOpacity style={styles.unmuteBanner} onPress={resumeAudio} activeOpacity={0.9}>
            <Ionicons name="volume-high" size={16} color="#fff" />
            <Text style={styles.unmuteText}>Tap to enable audio</Text>
          </TouchableOpacity>
        ) : null}

        {addSheet}

        <View style={[styles.videoControls, { paddingBottom: insets.bottom + 22 }]} pointerEvents="box-none">
          <CallControls
            isVideo
            forceDark
            micOn={call?.micOn}
            cameraOn={call?.cameraOn}
            screenSharing={call?.screenSharing}
            speakerOn={call?.speakerOn}
            speakerSupported={audioRouteSupported}
            onToggleMic={toggleMic}
            onToggleCamera={toggleCamera}
            onSwitchCamera={switchCamera}
            onToggleScreenShare={toggleScreenShare}
            onToggleSpeaker={toggleSpeaker}
            onHangup={hangup}
          />
        </View>
      </View>
    );
  }

  // ---- Audio / incoming / outgoing / ended: opaque full-screen ----
  return (
    <View style={[styles.root, { backgroundColor: screenBg, paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      {/* WhatsApp chat wallpaper as the call backdrop (theme-aware doodle SVG). */}
      <ChatWallpaper isDarkMode={isDarkMode} />

      {/* Minimize to a floating window (WhatsApp-style) — hidden on an
          unanswered incoming ring, which stays full-screen with Accept/Decline. */}
      {canMinimize ? (
        <TouchableOpacity
          onPress={minimize}
          style={[styles.minimizeFloating, { top: insets.top + 6, backgroundColor: minBtnBg }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="chevron-down" size={26} color={minBtnIcon} />
        </TouchableOpacity>
      ) : null}

      {/* Add participant (group calls) — mirrors the minimize button, top-right. */}
      {canAddParticipants ? (
        <TouchableOpacity
          onPress={() => setShowAddSheet(true)}
          style={[styles.addFloating, { top: insets.top + 6, backgroundColor: minBtnBg }]}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="person-add" size={22} color={minBtnIcon} />
        </TouchableOpacity>
      ) : null}
      {addSheet}

      {showIncomingActions && !isGroup ? (
        <IncomingCallCard
          peer={peer}
          displayName={peerDisplayName}
          media={call?.media}
          onAccept={accept}
          onReject={reject}
          // WhatsApp's Message action: pass on the call and land in the chat
          // thread to reply by text (decline + deep-link to the conversation).
          onMessage={() => {
            reject();
            if (call?.chatId) {
              navigateToChat({
                chatId: call.chatId,
                chatType: 'private',
                chatName: peerDisplayName,
                chatAvatar: peer?.avatar || '',
              });
            }
          }}
        />
      ) : isGroup ? (
        // ----- GROUP (audio, or pre-video ringing/ended) -----
        <>
          <View style={styles.identity}>
            <Text style={[styles.subtitle, { color: onBgSoft }]}>{subtitle}</Text>
            <Text style={[styles.groupName, { color: onBg }]} numberOfLines={1}>{groupTitle}</Text>
            <View style={styles.gridWrap}>
              <CallParticipantsGrid
                participants={gridParticipants}
                ringing={ringing}
                activeSpeakerId={call?.activeSpeakerId || null}
              />
            </View>
            {timerRunning ? (
              <CallTimer startMs={call?.answeredAt} style={[styles.activeTimer, { color: onBg }]} />
            ) : null}
          </View>

          {call?.needsUnmuteGesture && status === CALL_STATUS.ACTIVE ? (
            <TouchableOpacity style={styles.unmuteBanner} onPress={resumeAudio} activeOpacity={0.9}>
              <Ionicons name="volume-high" size={16} color="#fff" />
              <Text style={styles.unmuteText}>Tap to enable audio</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.bottom}>
            {(status === CALL_STATUS.ACTIVE || accepted || status === CALL_STATUS.OUTGOING) ? (
              <CallControls
                isVideo={isVideo}
                micOn={call?.micOn}
                cameraOn={call?.cameraOn}
                screenSharing={call?.screenSharing}
                speakerOn={call?.speakerOn}
                speakerSupported={audioRouteSupported}
                onToggleMic={toggleMic}
                onToggleCamera={toggleCamera}
                onSwitchCamera={switchCamera}
                onToggleScreenShare={toggleScreenShare}
                onToggleSpeaker={toggleSpeaker}
                onHangup={hangup}
              />
            ) : showIncomingActions ? (
              <View style={styles.incomingActions}>
                <View style={styles.actionItem}>
                  <TouchableOpacity activeOpacity={0.85} onPress={reject} style={[styles.action, styles.decline]}>
                    <MaterialIcons name="call-end" size={32} color="#fff" />
                  </TouchableOpacity>
                  <Text style={[styles.actionLabel, { color: onBgSoft }]}>Decline</Text>
                </View>
                <View style={styles.actionItem}>
                  <TouchableOpacity activeOpacity={0.85} onPress={accept} style={[styles.action, styles.accept]}>
                    <Ionicons name={isVideo ? 'videocam' : 'call'} size={30} color="#fff" />
                  </TouchableOpacity>
                  <Text style={[styles.actionLabel, { color: onBgSoft }]}>Accept</Text>
                </View>
              </View>
            ) : showEndButton ? (
              <View style={styles.singleEndWrap}>
                <TouchableOpacity activeOpacity={0.85} onPress={hangup} style={styles.endBtn}>
                  <MaterialIcons name="call-end" size={34} color="#fff" />
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </>
      ) : (
        // ----- 1:1 (audio, or pre-video ringing/ended) -----
        <>
          {/* WhatsApp-style header: NAME centered at the top, with the status
              line under it — "Ringing…" (or Calling…/Reconnecting…/ended text)
              until the call is ANSWERED, then ONLY the running timer. Never
              both at once. */}
          <View style={styles.header}>
            <Text style={[styles.headerName, { color: onBg }]} numberOfLines={1}>{peerDisplayName}</Text>
            {timerRunning ? (
              <CallTimer startMs={call?.answeredAt} style={[styles.headerStatus, { color: onBgSoft }]} />
            ) : (
              <Text style={[styles.headerStatus, { color: onBgSoft }]}>
                {subtitle || (isVideo ? 'Video call' : 'Voice call')}
              </Text>
            )}
          </View>

          {/* Large centered avatar (WhatsApp active-call stage). */}
          <View style={styles.avatarStage}>
            <View style={styles.avatarStack}>
              <PulsingRing size={170} active={ringing} color={ringColor} />
              <View style={[styles.avatarWrap, { borderColor: avatarBorder }]}>
                <CallAvatar uri={peer?.avatar} name={peer?.name} id={peer?.id} size={170} />
              </View>
            </View>
          </View>

          {call?.needsUnmuteGesture && status === CALL_STATUS.ACTIVE ? (
            <TouchableOpacity style={styles.unmuteBanner} onPress={resumeAudio} activeOpacity={0.9}>
              <Ionicons name="volume-high" size={16} color="#fff" />
              <Text style={styles.unmuteText}>Tap to enable audio</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.bottom}>
            {(status === CALL_STATUS.ACTIVE || accepted || status === CALL_STATUS.OUTGOING) ? (
              <CallControls
                isVideo={isVideo}
                micOn={call?.micOn}
                cameraOn={call?.cameraOn}
                screenSharing={call?.screenSharing}
                speakerOn={call?.speakerOn}
                speakerSupported={audioRouteSupported}
                onToggleMic={toggleMic}
                onToggleCamera={toggleCamera}
                onSwitchCamera={switchCamera}
                onToggleScreenShare={toggleScreenShare}
                onToggleSpeaker={toggleSpeaker}
                onHangup={hangup}
              />
            ) : showEndButton ? (
              <View style={styles.singleEndWrap}>
                <TouchableOpacity activeOpacity={0.85} onPress={hangup} style={styles.endBtn}>
                  <MaterialIcons name="call-end" size={34} color="#fff" />
                </TouchableOpacity>
              </View>
            ) : null}
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#0B141A',
    zIndex: 999,
    elevation: 999,
  },
  identity: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 40 },
  // WhatsApp-style 1:1 active-call header: name centered at the top (between
  // the floating minimize / add-participant corner buttons), status/timer under.
  header: { alignItems: 'center', paddingTop: 14, paddingHorizontal: 64 },
  headerName: {
    fontFamily: 'Roboto-SemiBold',
    fontSize: 22,
    textAlign: 'center',
    maxWidth: '100%',
  },
  headerStatus: {
    fontFamily: 'Roboto-Regular',
    fontSize: 14,
    marginTop: 5,
  },
  avatarStage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  subtitle: {
    color: 'rgba(255,255,255,0.75)',
    fontFamily: 'Roboto-Medium',
    fontSize: 14,
    marginBottom: 26,
  },
  avatarStack: { alignItems: 'center', justifyContent: 'center' },
  avatarWrap: {
    borderRadius: 80,
    borderWidth: 3,
    borderColor: 'rgba(255,255,255,0.16)',
    padding: 3,
  },
  name: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 27,
    marginTop: 22,
    maxWidth: '82%',
    textAlign: 'center',
  },
  groupName: {
    color: '#fff',
    fontFamily: 'Roboto-SemiBold',
    fontSize: 24,
    marginBottom: 28,
    maxWidth: '82%',
    textAlign: 'center',
  },
  gridWrap: { width: '100%' },
  mediaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10 },
  mediaText: { color: 'rgba(255,255,255,0.8)', fontFamily: 'Roboto-Regular', fontSize: 13 },
  activeTimer: { marginTop: 18, fontSize: 16 },
  bottom: { paddingBottom: 30, paddingTop: 10 },
  singleEndWrap: { alignItems: 'center' },
  endBtn: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#EA0038',
    alignItems: 'center', justifyContent: 'center',
  },
  // group incoming accept/decline
  incomingActions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 40,
  },
  actionItem: { alignItems: 'center', gap: 10 },
  action: {
    width: 70, height: 70, borderRadius: 35,
    alignItems: 'center', justifyContent: 'center',
  },
  decline: { backgroundColor: '#EA0038' },
  accept: { backgroundColor: '#00C853' },
  actionLabel: { color: 'rgba(255,255,255,0.85)', fontFamily: 'Roboto-Regular', fontSize: 13 },
  // video overlay
  videoRoot: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'transparent',
    zIndex: 999,
    elevation: 999,
    justifyContent: 'space-between',
  },
  videoTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 14,
    backgroundColor: 'rgba(0,0,0,0.28)',
  },
  videoTitleCol: { flex: 1 },
  minBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  addFloating: {
    position: 'absolute',
    right: 14,
    zIndex: 2,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  minimizeFloating: {
    position: 'absolute',
    left: 14,
    zIndex: 2,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.14)',
  },
  videoName: { color: '#fff', fontFamily: 'Roboto-SemiBold', fontSize: 18 },
  videoSub: { color: 'rgba(255,255,255,0.8)', fontFamily: 'Roboto-Regular', fontSize: 13, marginTop: 2 },
  videoControls: {
    paddingTop: 16,
  },
  unmuteBanner: {
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
  },
  unmuteText: { color: '#fff', fontFamily: 'Roboto-Medium', fontSize: 13 },
});
