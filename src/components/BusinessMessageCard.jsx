// One message in a read-only business chat, drawn like the template the
// business used: header → media → body → footer → time, at one fixed width so
// the list never jumps while media loads. See docs/BUSINESS_CHAT_README.md §3.4.
//
// Media shows by itself — no download icon, ring, "Tap to download", blur gate
// or "Paused • Resume" (BlurGateImage is the download gate; never use it here).
// API messages have no media record, so when `mediaUrl` fails the file is
// fetched once through the api-media endpoint (services/businessMedia).
//
// Document viewing: PDF on iOS opens BusinessDocumentViewer (in-app WebView,
// copy deleted on close); Android hands the cached file to the system viewer
// (IntentLauncher ACTION_VIEW — WebView can't render PDFs, needs a PDF app).
// Other document types: system viewer on Android, "can only be viewed on the
// web" on iOS. See the decision note at the top of BusinessDocumentViewer.jsx.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Platform, StyleSheet, Text, TouchableOpacity, View, useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { cachedImageSource } from '../utils/imageSource';
import { useVideoPlayer, VideoView } from 'expo-video';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Ionicons } from '@expo/vector-icons';
import BusinessDocumentViewer from './BusinessDocumentViewer';
import { fetchBusinessMedia, deleteBusinessMedia } from '../services/businessMedia';

const MAX_CARD_W = 360;
const UNAVAILABLE_TEXT = 'This file is no longer available.';

const DOC_COLORS = {
  pdf: '#E53935',
  doc: '#1565C0',
  docx: '#1565C0',
  xls: '#2E7D32',
  xlsx: '#2E7D32',
  csv: '#2E7D32',
  ppt: '#E65100',
  pptx: '#E65100',
};
const DEFAULT_DOC_COLOR = '#03b0a2';

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// "193 B" / "12 KB" / "1.4 MB". Empty when unknown — never "Size unknown".
export const formatBytes = (bytes) => {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const fileNameOf = (msg) => {
  const meta = msg?.mediaMeta || msg?.payload?.mediaMeta || {};
  if (meta.fileName) return String(meta.fileName);
  const tail = String(msg?.mediaUrl || '').split('?')[0].split('/').pop();
  return tail ? decodeURIComponent(tail) : 'Document';
};

const extOf = (name) => {
  const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

const kindOf = (msg) => {
  const t = String(msg?.messageType || msg?.type || msg?.mediaType || 'text').toLowerCase();
  if (t === 'image' || t === 'photo') return 'image';
  if (t === 'video') return 'video';
  if (t === 'document' || t === 'file') return 'document';
  return 'text';
};

// The template parts to draw: `templateParts` when the message was built from a
// template, else the whole `text` as the body (minus a bare file name, which the
// document card already shows). Old messages have no templateParts.
export const businessParts = (msg) => {
  const parts = msg?.templateParts || msg?.payload?.templateParts || null;
  const headerText = parts?.headerText ? String(parts.headerText).trim() : '';
  let body = String((parts ? parts.body : msg?.text) || '').trim();
  if (kindOf(msg) === 'document' && body && body === fileNameOf(msg)) body = '';
  const footer = parts?.footer ? String(parts.footer).trim() : '';
  return { headerText, body, footer };
};

// ─── Image ───────────────────────────────────────────────────────────────────
function BusinessImage({ msg, width, onOpen, onLongPress }) {
  const [uri, setUri] = useState(msg?.mediaUrl || null);
  const [stage, setStage] = useState(msg?.mediaUrl ? 'remote' : 'fetching');
  const cachedRef = useRef(null);

  const fetchViaApi = useCallback(() => {
    setStage('fetching');
    fetchBusinessMedia(msg).then((fileUri) => {
      cachedRef.current = fileUri;
      setUri(fileUri);
      setStage('cached');
    }).catch(() => setStage('failed'));
  }, [msg]);

  useEffect(() => {
    if (!msg?.mediaUrl) fetchViaApi();
    return () => { deleteBusinessMedia(cachedRef.current); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // First failure → retry once through the endpoint; second → unavailable.
  const onError = useCallback(() => {
    if (stage === 'remote') fetchViaApi();
    else setStage('failed');
  }, [stage, fetchViaApi]);

  const height = Math.round((width * 3) / 4);
  if (stage === 'failed') {
    return (
      <View style={[styles.mediaBox, styles.unavailable, { width, height }]}>
        <Ionicons name="image-outline" size={28} color="#9AA0A6" />
        <Text style={styles.unavailableText}>{UNAVAILABLE_TEXT}</Text>
      </View>
    );
  }
  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={() => uri && stage !== 'fetching' && onOpen?.(msg, uri)}
      onLongPress={onLongPress}
      delayLongPress={300}
    >
      <View style={[styles.mediaBox, { width, height }]}>
        {uri && stage !== 'fetching' ? (
          <Image
            // Stable cache key (the S3 path without the presigned query): the
            // signed URL changes on every fetch, so keyed by the full URL each
            // open re-downloaded the picture — a dark box, then a fade-in.
            source={stage === 'remote' ? cachedImageSource(uri) : { uri }}
            cachePolicy="memory-disk"
            style={styles.fill}
            contentFit="cover"
            transition={0}
            onError={onError}
          />
        ) : (
          <ActivityIndicator color="#fff" />
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── Video ───────────────────────────────────────────────────────────────────
function BusinessVideo({ msg, width }) {
  const [stage, setStage] = useState('remote');
  const cachedRef = useRef(null);
  const stageRef = useRef('remote');
  stageRef.current = stage;
  const player = useVideoPlayer(msg?.mediaUrl || null, (p) => { p.loop = false; });

  useEffect(() => {
    const sub = player.addListener('statusChange', ({ status }) => {
      if (status !== 'error') return;
      if (stageRef.current !== 'remote') { setStage('failed'); return; }
      // One retry through the api-media endpoint.
      setStage('fetching');
      fetchBusinessMedia(msg).then(async (fileUri) => {
        cachedRef.current = fileUri;
        if (typeof player.replaceAsync === 'function') await player.replaceAsync(fileUri);
        else player.replace(fileUri);
        setStage('cached');
      }).catch(() => setStage('failed'));
    });
    return () => {
      sub.remove();
      deleteBusinessMedia(cachedRef.current);
    };
  }, [player, msg]);

  const height = Math.round((width * 9) / 16);
  if (stage === 'failed') {
    return (
      <View style={[styles.mediaBox, styles.unavailable, { width, height }]}>
        <Ionicons name="videocam-outline" size={28} color="#9AA0A6" />
        <Text style={styles.unavailableText}>{UNAVAILABLE_TEXT}</Text>
      </View>
    );
  }
  return (
    <View style={[styles.mediaBox, { width, height }]}>
      <VideoView player={player} style={styles.fill} nativeControls contentFit="contain" />
      {stage === 'fetching' ? (
        <View style={styles.overlay}>
          <ActivityIndicator color="#fff" />
        </View>
      ) : null}
    </View>
  );
}

// ─── Document ────────────────────────────────────────────────────────────────
function BusinessDocument({ msg, theme, onLongPress }) {
  const name = fileNameOf(msg);
  const ext = extOf(name);
  const meta = msg?.mediaMeta || msg?.payload?.mediaMeta || {};
  const size = formatBytes(meta.fileSize);
  const subline = [size, ext ? ext.toUpperCase() : 'FILE'].filter(Boolean).join(' • ');
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState({ visible: false, uri: null });
  const cachedRef = useRef(null);

  useEffect(() => () => { deleteBusinessMedia(cachedRef.current); }, []);

  const closeViewer = useCallback(() => {
    setViewer({ visible: false, uri: null });
    deleteBusinessMedia(cachedRef.current);
    cachedRef.current = null;
  }, []);

  const openOnAndroid = async (fileUri) => {
    const contentUri = await FileSystem.getContentUriAsync(fileUri);
    try {
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        flags: 1, // FLAG_GRANT_READ_URI_PERMISSION
        type: meta.mimeType || MIME_BY_EXT[ext] || '*/*',
      });
    } catch {
      Alert.alert('No app found', 'No app on this phone can open this file.');
    } finally {
      deleteBusinessMedia(fileUri);
      cachedRef.current = null;
    }
  };

  const onOpen = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fileUri = await fetchBusinessMedia(msg);
      cachedRef.current = fileUri;
      if (Platform.OS === 'android') {
        await openOnAndroid(fileUri);
      } else if (ext === 'pdf' || String(meta.mimeType || '').toLowerCase() === 'application/pdf') {
        setViewer({ visible: true, uri: fileUri });
      } else {
        // iOS shows PDFs in-app only; other document types are web-only for now.
        deleteBusinessMedia(fileUri);
        cachedRef.current = null;
        Alert.alert(name, 'This file can only be viewed on the web.');
      }
    } catch (e) {
      // A business's own https link is not proxied — use it directly.
      if (e?.code === 'not_proxyable' && msg?.mediaUrl) {
        if (Platform.OS === 'ios') setViewer({ visible: true, uri: msg.mediaUrl });
        else Linking.openURL(msg.mediaUrl).catch(() => Alert.alert('', UNAVAILABLE_TEXT));
      } else if (e?.code === 'network') {
        Alert.alert('Offline', 'Connect to the internet to open this file.');
      } else {
        Alert.alert('', UNAVAILABLE_TEXT);
      }
    } finally {
      setBusy(false);
    }
  };

  const color = DOC_COLORS[ext] || DEFAULT_DOC_COLOR;
  const textColor = theme.colors.bubbleReceivedText;
  const muted = theme.colors.secondaryTextColor || theme.colors.placeHolderTextColor;
  return (
    <>
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={onOpen}
        onLongPress={onLongPress}
        delayLongPress={300}
        style={styles.docRow}
        accessibilityRole="button"
        accessibilityLabel={`Open ${name}`}
      >
        <View style={[styles.docTile, { backgroundColor: color }]}>
          <Text style={styles.docTileText} numberOfLines={1}>{(ext || 'file').toUpperCase().slice(0, 4)}</Text>
        </View>
        <View style={styles.docInfo}>
          <Text style={[styles.docName, { color: textColor }]} numberOfLines={2}>{name}</Text>
          <Text style={[styles.docSub, { color: muted }]} numberOfLines={1}>{subline}</Text>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={muted} />
        ) : (
          <Ionicons name="eye-outline" size={22} color={muted} />
        )}
      </TouchableOpacity>
      {Platform.OS === 'ios' ? (
        <BusinessDocumentViewer
          visible={viewer.visible}
          uri={viewer.uri}
          title={name}
          onClose={closeViewer}
        />
      ) : null}
    </>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────
export default function BusinessMessageCard({
  msg, timeLabel, theme, renderBodyText, onOpenImage, onLongPress,
}) {
  const { width: winW } = useWindowDimensions();
  const cardW = Math.min(Math.round(winW * 0.88), MAX_CARD_W);
  const mediaW = cardW - (styles.card.padding * 2);

  const kind = kindOf(msg);
  const { headerText, body, footer } = businessParts(msg);

  const textColor = theme.colors.bubbleReceivedText;
  const muted = theme.colors.secondaryTextColor || theme.colors.placeHolderTextColor;

  return (
    <View style={[styles.card, { width: cardW, backgroundColor: theme.colors.bubbleReceived }]}>
      {headerText ? (
        <Text style={[styles.header, { color: textColor }]}>{headerText}</Text>
      ) : null}

      {kind === 'image' ? (
        <View style={styles.block}>
          <BusinessImage msg={msg} width={mediaW} onOpen={onOpenImage} onLongPress={onLongPress} />
        </View>
      ) : null}
      {kind === 'video' ? (
        <View style={styles.block}>
          <BusinessVideo msg={msg} width={mediaW} />
        </View>
      ) : null}
      {kind === 'document' ? (
        <View style={styles.block}>
          <BusinessDocument msg={msg} theme={theme} onLongPress={onLongPress} />
        </View>
      ) : null}

      {body ? (
        <View style={styles.block}>
          {renderBodyText
            ? renderBodyText(body)
            : <Text style={[styles.body, { color: textColor }]}>{body}</Text>}
        </View>
      ) : null}

      {footer ? (
        <Text style={[styles.footer, { color: muted }]}>{footer}</Text>
      ) : null}

      <Text style={[styles.time, { color: muted }]}>{timeLabel}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: 6,
    borderRadius: 10,
    borderTopLeftRadius: 2,
  },
  block: { marginTop: 4 },
  header: {
    paddingHorizontal: 4,
    paddingTop: 2,
    fontSize: 15,
    fontFamily: 'Roboto-Bold',
  },
  body: {
    paddingHorizontal: 4,
    fontSize: 15,
    fontFamily: 'Roboto-Regular',
  },
  footer: {
    paddingHorizontal: 4,
    marginTop: 4,
    fontSize: 12,
    fontFamily: 'Roboto-Regular',
  },
  time: {
    alignSelf: 'flex-end',
    marginTop: 2,
    marginRight: 2,
    fontSize: 11,
    fontFamily: 'Roboto-Regular',
  },
  mediaBox: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#1F2C33',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fill: { width: '100%', height: '100%' },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  unavailable: { paddingHorizontal: 16 },
  unavailableText: {
    marginTop: 6,
    color: '#C4C9CC',
    fontSize: 13,
    textAlign: 'center',
    fontFamily: 'Roboto-Regular',
  },
  docRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 8,
    backgroundColor: 'rgba(127,127,127,0.12)',
  },
  docTile: {
    width: 40,
    height: 48,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  docTileText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'Roboto-Bold',
  },
  docInfo: { flex: 1, marginHorizontal: 10 },
  docName: { fontSize: 14, fontFamily: 'Roboto-Medium' },
  docSub: { marginTop: 2, fontSize: 12, fontFamily: 'Roboto-Regular' },
});
