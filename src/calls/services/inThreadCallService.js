import { DeviceEventEmitter } from 'react-native';
import moment from 'moment';
import ChatDatabase from '../../services/ChatDatabase';

/**
 * Writes a WhatsApp-style "call" entry into the local chat thread (SQLite) so it
 * shows in the conversation and survives reload. Each device writes its OWN
 * side; the durable cross-device copy lives in the backend CallLog.
 *
 * The entry is a message of type 'call'; render details ride in `payload`
 * (round-trips via ChatDatabase's payload column). No live message pipeline is
 * touched.
 */

const labelFor = (media, direction, outcome) => {
  const kind = media === 'video' ? 'video' : 'voice';
  if (outcome === 'missed') return `Missed ${kind} call`;
  if (outcome === 'rejected') return direction === 'outgoing' ? 'Call declined' : 'Declined call';
  if (outcome === 'cancelled') return direction === 'outgoing' ? 'Cancelled call' : 'Missed call';
  if (outcome === 'failed') return `${kind === 'video' ? 'Video' : 'Voice'} call`;
  // completed
  return direction === 'outgoing' ? `Outgoing ${kind} call` : `Incoming ${kind} call`;
};

export const appendCallEntry = async ({
  callId, peerId, chatId, media, direction, outcome, durationSec = 0, myId,
}) => {
  if (!chatId || !callId) return;

  const nowIso = new Date().toISOString();
  const isOutgoing = direction === 'outgoing';
  const senderId = isOutgoing ? (myId || null) : (peerId || null);

  const text = labelFor(media, direction, outcome);

  const msg = {
    id: `call_${callId}_${myId || 'me'}`,
    type: 'call',
    mediaType: 'call',
    text,
    senderId,
    senderType: isOutgoing ? 'self' : 'other',
    receiverId: isOutgoing ? peerId : (myId || null),
    status: 'sent',
    createdAt: nowIso,
    time: moment(nowIso).format('hh:mm A'),
    date: moment(nowIso).format('YYYY-MM-DD'),
    timestamp: Date.now(),
    chatId,
    payload: {
      kind: 'call',
      callId,
      media: media === 'video' ? 'video' : 'audio',
      direction,
      outcome,
      durationSec: Math.max(0, Number(durationSec) || 0),
    },
  };

  try {
    await ChatDatabase.upsertMessage(msg);
    DeviceEventEmitter.emit('call:thread:update', { chatId });
  } catch (_) {
    // best-effort; the backend CallLog is the durable record
  }
};
