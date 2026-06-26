/**
 * Expo config plugin: iOS app-switcher / lock-screen snapshot guard.
 *
 * iOS has no FLAG_SECURE. When the app resigns active (lock button, auto-lock,
 * app-switch, incoming system UI) the OS captures a snapshot of the live screen
 * for the app switcher — which would reveal chats. The JS privacy overlay in
 * CallProvider helps, but a JS render is not guaranteed to commit a frame before
 * the OS snapshots. The only race-free fix is native: add an opaque branded view
 * to the key window in `applicationWillResignActive` (before the snapshot) and
 * remove it in `applicationDidBecomeActive`.
 *
 * `ios/` is git-ignored (Continuous Native Generation), so this AppDelegate
 * change MUST live in a config plugin to survive `expo prebuild` / EAS builds.
 *
 * Companion JS: src/components/PrivacyOverlay.jsx (the cross-platform overlay)
 * and the AppState/FLAG_SECURE wiring in src/calls/CallProvider.jsx.
 *
 * Pairs with ./plugins/withIosVoip — both patch AppDelegate.swift; the insertion
 * anchor here (after `var reactNativeFactory`) is independent of withIosVoip's
 * anchors, so the two compose regardless of array order.
 *
 * NOTE: the logo uses `UIImage(named: "icon0")`, falling back to nil → a solid
 * brand screen if that image is not in the native asset catalog. To render the
 * logo on iOS, add an `icon0` image set to the Xcode asset catalog; the privacy
 * guarantee holds either way (solid #0B141A fill with no readable content).
 */
const { withAppDelegate } = require('@expo/config-plugins');

// #0B141A (WhatsApp-dark) — matches the JS PrivacyOverlay background.
const PRIVACY_BLOCK = `
  // MARK: - Privacy screen (app-switcher snapshot guard) — added by withIosPrivacyScreen
  private var privacyCoverView: UIView?

  public override func applicationWillResignActive(_ application: UIApplication) {
    super.applicationWillResignActive(application)
    guard let window = self.window, privacyCoverView == nil else { return }
    let cover = UIView(frame: window.bounds)
    cover.backgroundColor = UIColor(red: 0.043, green: 0.078, blue: 0.102, alpha: 1.0)
    cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    if let logo = UIImage(named: "icon0") {
      let imageView = UIImageView(image: logo)
      imageView.contentMode = .scaleAspectFit
      imageView.translatesAutoresizingMaskIntoConstraints = false
      cover.addSubview(imageView)
      NSLayoutConstraint.activate([
        imageView.centerXAnchor.constraint(equalTo: cover.centerXAnchor),
        imageView.centerYAnchor.constraint(equalTo: cover.centerYAnchor),
        imageView.widthAnchor.constraint(equalToConstant: 120),
        imageView.heightAnchor.constraint(equalToConstant: 120),
      ])
    }
    window.addSubview(cover)
    privacyCoverView = cover
  }

  public override func applicationDidBecomeActive(_ application: UIApplication) {
    super.applicationDidBecomeActive(application)
    privacyCoverView?.removeFromSuperview()
    privacyCoverView = nil
  }
`;

const withIosPrivacyScreen = (config) =>
  withAppDelegate(config, (cfg) => {
    let src = cfg.modResults.contents;

    // Idempotent: only inject once.
    if (!src.includes('withIosPrivacyScreen')) {
      src = src.replace(
        /(\n\s*var reactNativeFactory: RCTReactNativeFactory\?\n)/,
        `$1${PRIVACY_BLOCK}`,
      );
    }

    cfg.modResults.contents = src;
    return cfg;
  });

module.exports = withIosPrivacyScreen;
