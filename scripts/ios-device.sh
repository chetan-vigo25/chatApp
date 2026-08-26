#!/usr/bin/env bash
#
# Install + launch the debug build on a wired iPhone using devicectl.
#
# WHY THIS EXISTS
#   `npx expo run:ios` builds fine but dies at the install step with
#     CommandError: InvalidHostID
#   Expo CLI installs through its OWN JS implementation of Apple's
#   usbmux/lockdown protocol (@expo/cli .../appleDevice/client/LockdowndClient.js)
#   which sends StartSession { HostID } read from /var/db/lockdown. When that
#   legacy pair record is stale the device answers InvalidHostID, and Expo only
#   falls back to devicectl for a DIFFERENT error code (APPLE_DEVICE_USBMUXD) —
#   so it just throws. Xcode's modern CoreDevice pairing is a separate record
#   and is perfectly healthy, so devicectl installs without complaint.
#
# USAGE
#   ./scripts/ios-device.sh            # install + launch
#   ./scripts/ios-device.sh --console  # install + launch, stream native logs
#   JS console.log output lives in the Metro terminal (`npx expo start --dev-client`),
#   not here — start that first.
#
set -euo pipefail

APP_NAME="${APP_NAME:-TalksTry}"
BUNDLE_ID="${BUNDLE_ID:-com.chat.baatCheet}"
CONSOLE=""
[ "${1:-}" = "--console" ] && CONSOLE="--console"

# ---- pick the wired device -------------------------------------------------
TMP="$(mktemp -t devicectl)"
xcrun devicectl list devices --json-output "$TMP" >/dev/null
DEVICE="$(python3 - "$TMP" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1]))["result"]["devices"]
wired = [d for d in devices
         if d.get("connectionProperties", {}).get("transportType") == "wired"]
print(wired[0]["identifier"] if wired else "")
PY
)"
rm -f "$TMP"
if [ -z "$DEVICE" ]; then
  echo "No wired device found. Plug the iPhone in, unlock it, and trust this Mac." >&2
  exit 1
fi

# ---- pick the freshest build ----------------------------------------------
APP="$(ls -dt "$HOME/Library/Developer/Xcode/DerivedData/$APP_NAME-"*/Build/Products/Debug-iphoneos/"$APP_NAME.app" 2>/dev/null | head -1)"
if [ -z "$APP" ]; then
  echo "No built $APP_NAME.app found. Run 'npx expo run:ios' first —" >&2
  echo "its BUILD succeeds; only its install step fails, and this script replaces that." >&2
  exit 1
fi

echo "device : $DEVICE"
echo "app    : $APP"
xcrun devicectl device install app --device "$DEVICE" "$APP"
# shellcheck disable=SC2086
xcrun devicectl device process launch $CONSOLE --terminate-existing --device "$DEVICE" "$BUNDLE_ID"
