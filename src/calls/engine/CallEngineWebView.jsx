import React, { forwardRef, useMemo, useRef, useCallback } from 'react';
import { WebView } from 'react-native-webview';
import { buildCallEngineHtml, CALL_ENGINE_BASE_URL } from './callEngineHtml';
import { parseEngineEvent } from './protocol';

/**
 * The persistent WebView that hosts the browser CallingSDK. CallProvider holds
 * the ref (to inject commands) and handles every event via `onEvent`.
 *
 * Loaded with baseUrl = the calling-service origin so getUserMedia runs in a
 * secure context and the SDK's same-origin socket resolves.
 */
const CallEngineWebView = forwardRef(function CallEngineWebView({ onEvent, style }, ref) {
  const html = useMemo(() => buildCallEngineHtml(), []);
  // Keep our own handle alongside the forwarded ref so the process-gone
  // handlers below can reload this exact WebView instance.
  const innerRef = useRef(null);
  const setRefs = useCallback((node) => {
    innerRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  }, [ref]);
  // The OS can kill a parked/backgrounded WebView renderer (Android) or content
  // process (iOS). Without an explicit reload the engine page is simply GONE —
  // every later call fails with 'not connected' until the app restarts. Reload
  // brings the page back; its 'engine html loaded' log then makes CallProvider
  // reset the stale ready flag and reconnect the SDK.
  const reload = useCallback(() => {
    try { innerRef.current && innerRef.current.reload(); } catch (_) {}
  }, []);

  return (
    <WebView
      ref={setRefs}
      onRenderProcessGone={reload}
      onContentProcessDidTerminate={reload}
      source={{ html, baseUrl: CALL_ENGINE_BASE_URL }}
      originWhitelist={['https://*', 'http://*']}
      style={style}
      // Media playback
      allowsInlineMediaPlayback
      mediaPlaybackRequiresUserAction={false}
      allowsAirPlayForMediaPlayback
      // Camera/mic capture grant (iOS 15+). This WebView only ever loads our own
      // first-party call engine, so grant getUserMedia outright — the app already
      // holds (and prompts for) the OS mic/camera permission, and "grant" avoids
      // host-matching edge cases that silently DENY capture on iOS (leaving the
      // call with no audio/video). Android grants via the app's runtime permissions.
      mediaCapturePermissionGrantType="grant"
      // Android: allow protected/mixed content so SDK assets + media load.
      allowsProtectedMedia
      mixedContentMode="always"
      // JS bridge
      javaScriptEnabled
      domStorageEnabled
      setSupportMultipleWindows={false}
      onMessage={(e) => {
        const evt = parseEngineEvent(e?.nativeEvent?.data);
        if (evt && onEvent) onEvent(evt.type, evt.payload);
      }}
      onError={(e) => onEvent && onEvent('connectError', { message: e?.nativeEvent?.description || 'engine load error' })}
      onHttpError={(e) => onEvent && onEvent('connectError', { message: `engine http ${e?.nativeEvent?.statusCode || ''}` })}
    />
  );
});

export default CallEngineWebView;
