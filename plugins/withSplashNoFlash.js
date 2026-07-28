/**
 * Expo config plugin: stop the splash LOGO from flashing when the Activity is
 * recreated.
 *
 * MainActivity's manifest theme is `Theme.App.SplashScreen`, whose
 * windowBackground is a layer-list = white background + the centered app logo.
 * MainActivity.onCreate immediately calls setTheme(AppTheme) (no logo), so the
 * logo theme only applies at raw window creation — cold start AND, crucially,
 * whenever Android RECREATES the Activity. Granting the contacts permission on
 * Android recreates the Activity, so the logo windowBackground drew for a frame
 * before setTheme(AppTheme) ran — the "splash blink on first contact fetch".
 *
 * This plugin rewrites that theme's windowBackground to the plain splash
 * background COLOR (no logo). A recreation frame then repaints plain white,
 * invisible on the (white) contact screen, instead of flashing the logo. The
 * app's own Splash.jsx still renders the branded logo once JS boots, so the
 * cold-start experience keeps its splash.
 *
 * expo-splash-screen regenerates styles.xml on every `expo prebuild`, restoring
 * the logo windowBackground — so this runs as a plugin to re-apply the change
 * on each prebuild rather than relying on a hand-edit that a clean prebuild wipes.
 */
const { withAndroidStyles } = require('@expo/config-plugins');

const SPLASH_THEME = 'Theme.App.SplashScreen';
const PLAIN_BACKGROUND = '@color/splashscreen_background';
// Both must be pinned to a plain color:
//  • windowBackground        → the pre-JS window frame on any (re)creation
//  • windowSplashScreenBackground (API 31+) → the Android 12 system splash, which
//    otherwise follows the DayNight colorBackground and comes up DARK when the
//    device is in dark mode (the "dark splash blink" on the process-restart that
//    granting the contacts permission triggers).
const ITEMS = ['android:windowBackground', 'android:windowSplashScreenBackground'];

const withSplashNoFlash = (config) =>
  withAndroidStyles(config, (cfg) => {
    const styles = cfg.modResults?.resources?.style;
    if (!Array.isArray(styles)) return cfg;

    const splash = styles.find((s) => s?.$?.name === SPLASH_THEME);
    if (!splash) return cfg;
    if (!Array.isArray(splash.item)) splash.item = [];

    for (const name of ITEMS) {
      const existing = splash.item.find((i) => i?.$?.name === name);
      if (existing) {
        existing._ = PLAIN_BACKGROUND;
      } else {
        splash.item.push({ $: { name }, _: PLAIN_BACKGROUND });
      }
    }
    return cfg;
  });

module.exports = withSplashNoFlash;
