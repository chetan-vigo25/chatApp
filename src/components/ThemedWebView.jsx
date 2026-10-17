// ThemedWebView — WebView for the remote legal pages (privacy policy, terms).
//
// Those pages are served by the website and are light-only, so in dark mode they
// painted a full white page inside a black app (audit U-01). Until the pages
// ship a dark style of their own, dark mode inverts the page before first paint
// (same trick as a "dark reader"): invert + hue-rotate keeps hues recognisable,
// images/video are inverted back. The WebView surface itself takes the theme
// background so there is no white flash while loading.
//
// WHEN THE WEBSITE ADDS REAL DARK-MODE SUPPORT, DELETE `DARK_CSS` — otherwise the
// page would be inverted twice and turn light again.
import React, { useMemo } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useTheme } from '../contexts/ThemeContext';

const DARK_CSS = 'html{background:#fff;filter:invert(1) hue-rotate(180deg)}'
  + 'img,picture,video,canvas,svg image{filter:invert(1) hue-rotate(180deg)}';

// Runs before the page's own content, so the first painted frame is already dark.
const DARK_JS = `(function(){try{var s=document.createElement('style');s.innerHTML=${JSON.stringify(DARK_CSS)};(document.head||document.documentElement).appendChild(s);}catch(e){}})();true;`;

export default function ThemedWebView({ uri, style }) {
  const { theme, isDarkMode } = useTheme();
  const bg = theme.colors.background;
  const surface = useMemo(() => [styles.web, { backgroundColor: bg }, style], [bg, style]);
  return (
    <WebView
      source={{ uri }}
      style={surface}
      containerStyle={{ backgroundColor: bg }}
      startInLoadingState
      renderLoading={() => (
        <View style={[StyleSheet.absoluteFill, styles.loading, { backgroundColor: bg }]}>
          <ActivityIndicator color={theme.colors.themeColor} />
        </View>
      )}
      injectedJavaScriptBeforeContentLoaded={isDarkMode ? DARK_JS : undefined}
    />
  );
}

const styles = StyleSheet.create({
  web: { flex: 1 },
  loading: { alignItems: 'center', justifyContent: 'center' },
});
