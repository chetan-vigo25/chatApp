#!/usr/bin/env bash
#
# Browse / pull / push files inside the app's sandbox on a wired iPhone.
#
# WHY THIS EXISTS
#   macOS has no Finder view of an app's Documents/Library unless the app opts
#   into UIFileSharingEnabled. `xcrun devicectl device info files` reads the
#   whole appDataContainer over CoreDevice regardless, but the invocation is
#   long enough that nobody remembers it. This wraps it.
#
# USAGE
#   ./scripts/ios-files.sh ls                      # whole sandbox, recursive
#   ./scripts/ios-files.sh ls Documents            # one subdirectory
#   ./scripts/ios-files.sh tree                    # top level only
#   ./scripts/ios-files.sh pull /                  ~/Desktop/TalksTry-iPhone
#                                                  # "/" pulls the WHOLE sandbox
#   ./scripts/ios-files.sh pull Documents/SQLite   ~/Desktop
#   ./scripts/ios-files.sh push ./local.db         Documents/SQLite/TalksTry.db
#   ./scripts/ios-files.sh db                      # pull the chat SQLite db + open it
#
#   DEVICE=<name|udid> overrides device pick; BUNDLE_ID=<id> overrides the app.
#
set -euo pipefail

BUNDLE_ID="${BUNDLE_ID:-com.chat.baatCheet}"

# ---- pick the device (wired first, then any available) ---------------------
if [ -z "${DEVICE:-}" ]; then
  TMP="$(mktemp -t devicectl)"
  xcrun devicectl list devices --json-output "$TMP" >/dev/null
  DEVICE="$(python3 - "$TMP" <<'PY'
import json, sys
devs = json.load(open(sys.argv[1]))["result"]["devices"]
def usable(d): return "available" in (d.get("connectionProperties", {}).get("pairingState", "")
                                      or d.get("connectionProperties", {}).get("tunnelState", "")) \
                      or d.get("connectionProperties", {}).get("transportType") is not None
wired = [d for d in devs if d.get("connectionProperties", {}).get("transportType") == "wired"]
other = [d for d in devs if d.get("connectionProperties", {}).get("transportType")]
pick = (wired or other)
print(pick[0]["identifier"] if pick else "")
PY
)"
  rm -f "$TMP"
fi
if [ -z "$DEVICE" ]; then
  echo "No device found. Plug the iPhone in, unlock it, and trust this Mac." >&2
  exit 1
fi

# `info files` spells the user flag --username; `copy from/to` spells it --user.
DOMAIN=(--device "$DEVICE" --domain-type appDataContainer
        --domain-identifier "$BUNDLE_ID" --username mobile)
COPY=(--device "$DEVICE" --domain-type appDataContainer
      --domain-identifier "$BUNDLE_ID" --user mobile)

CMD="${1:-ls}"; shift || true

case "$CMD" in
  ls)
    SUB="${1:-}"
    if [ -n "$SUB" ]; then
      xcrun devicectl device info files "${DOMAIN[@]}" --subdirectory "$SUB"
    else
      xcrun devicectl device info files "${DOMAIN[@]}"
    fi
    ;;
  tree)
    xcrun devicectl device info files "${DOMAIN[@]}" --no-recurse
    ;;
  pull)
    SRC="${1:?usage: pull <device-path> [dest-dir]}"
    DEST="${2:-.}"
    mkdir -p "$DEST"
    xcrun devicectl device copy from "${COPY[@]}" \
      --source "$SRC" --destination "$DEST"
    echo "pulled $SRC -> $DEST"
    ;;
  push)
    SRC="${1:?usage: push <local-path> <device-path>}"
    DST="${2:?usage: push <local-path> <device-path>}"
    xcrun devicectl device copy to "${COPY[@]}" \
      --source "$SRC" --destination "$DST"
    echo "pushed $SRC -> $DST"
    ;;
  db)
    OUT="${1:-${TMPDIR:-/tmp}}"
    mkdir -p "$OUT"
    xcrun devicectl device copy from "${COPY[@]}" \
      --source Documents/SQLite --destination "$OUT"
    # copy from drops the directory's CONTENTS into --destination, not a subdir.
    echo "db at $OUT/TalksTry.db"
    echo "open with:  sqlite3 '$OUT/TalksTry.db' '.tables'"
    ;;
  *)
    sed -n '3,20p' "$0" >&2
    exit 1
    ;;
esac
