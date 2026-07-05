/**
 * Expo config plugin: make the `fmt` pod compile under Xcode 16.3+/26 clang.
 *
 * `ios/` is git-ignored (Continuous Native Generation), so the Podfile is
 * regenerated on every `expo prebuild` / `expo run:ios`. Any manual Podfile edit
 * is therefore lost — this plugin re-injects the fix each time.
 *
 * THE BUG: React Native 0.81 pins fmt 11.0.2, and RCT-Folly requires exactly
 * `fmt (= 11.0.2)`, so it can't be bumped. fmt 11.0.2 uses `consteval` compile-time
 * format-string checks (FMT_STRING) that newer clang rejects as "not a constant
 * expression" (fixed upstream only in fmt 11.1.0). A `-DFMT_USE_CONSTEVAL=0` flag
 * can't fix it: fmt's base.h unconditionally recomputes FMT_USE_CONSTEVAL and forces
 * it back to 1 whenever __cpp_consteval is defined.
 *
 * THE FIX: fmt already disables consteval for older Apple clang ("consteval is
 * broken in Apple clang"); newer Apple clang re-broke the same pattern, so we
 * broaden that guard to disable consteval on ALL Apple clang. Applied from the
 * Podfile `post_install` hook (fmt source only exists after `pod install`), where
 * we chmod the read-only header writable and patch it.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

// Ruby snippet injected into the Podfile's post_install block.
const FMT_PATCH_SNIPPET = `
    # ── fmt consteval fix (added by plugins/withFmtConstevalFix.js) ──
    # fmt 11.0.2 (pinned by RCT-Folly) fails on Xcode 16.3+/26 clang: its FMT_STRING
    # consteval checks are rejected as "not a constant expression". A -D flag can't
    # fix it (base.h recomputes FMT_USE_CONSTEVAL). fmt already disables consteval for
    # older Apple clang; broaden that guard to all Apple clang so the build succeeds.
    fmt_base = File.join(installer.sandbox.root, 'fmt', 'include', 'fmt', 'base.h')
    if File.exist?(fmt_base)
      contents = File.read(fmt_base)
      patched = contents.gsub(
        '#elif defined(__apple_build_version__) && __apple_build_version__ < 14000029L',
        '#elif defined(__apple_build_version__)')
      if patched != contents
        File.chmod(0644, fmt_base)
        File.write(fmt_base, patched)
        Pod::UI.puts '[fmt patch] Disabled consteval on Apple clang (Xcode 16.3+/26 compatibility)'
      end
    end
`;

const MARKER = 'withFmtConstevalFix.js';

function injectIntoPodfile(podfile) {
  if (podfile.includes(MARKER)) return podfile; // idempotent

  // Preferred anchor: right after the react_native_post_install(...) call, inside
  // the existing `post_install do |installer|` block.
  const anchor = /react_native_post_install\([\s\S]*?\)\n/;
  if (anchor.test(podfile)) {
    return podfile.replace(anchor, (m) => `${m}${FMT_PATCH_SNIPPET}`);
  }

  // Fallback: if the expected post_install shape isn't present, append a
  // standalone post_install block at end of file.
  return `${podfile}\n\npost_install do |installer|${FMT_PATCH_SNIPPET}end\n`;
}

const withFmtConstevalFix = (config) =>
  withDangerousMod(config, [
    'ios',
    (cfg) => {
      const podfilePath = path.join(cfg.modRequest.platformProjectRoot, 'Podfile');
      if (fs.existsSync(podfilePath)) {
        const podfile = fs.readFileSync(podfilePath, 'utf8');
        fs.writeFileSync(podfilePath, injectIntoPodfile(podfile));
      }
      return cfg;
    },
  ]);

module.exports = withFmtConstevalFix;
