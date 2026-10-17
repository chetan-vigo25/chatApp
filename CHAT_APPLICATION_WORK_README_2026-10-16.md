# chat-application (mobile app) — Work Summary

**Date:** 2026-10-16
**Scope:** `chat-application/` (React Native / Expo app) — everything changed **after the last commit** (`30996c0f`, 2026-10-09 "added draft"). All of it is still **uncommitted** in the working tree: 109 modified files + 22 new source files + 9 new unit-test files.

> Rule followed throughout: nothing was committed by me; it is all left in the working tree for you to review.
> Per-area audit reports (with finding IDs like `P-C-04`, `T-A-01`, `E-A-07`) live in the workspace root folders (`APP_UI_FULL_AUDIT_2026-10/`, `APP_LIBRARY_UPGRADES_2026-10/`, `CALL_AUDIT_2026-10/`, `PUSH_NOTIFICATIONS_AUDIT_2026-10/`, `RECEIPTS_TICKS_AUDIT_2026-10/`, `OFFLINE_DELIVERY_AUDIT_2026-10/`, `MESSAGE_EDIT_AUDIT_2026-10/`, `MEDIA_DOWNLOAD_STATE_AUDIT_2026-10/`, `APP_PERFORMANCE_AUDIT_2026-10/`).

---

## 0. Read this first (testing status / what needs a rebuild)

| Item | Status |
|---|---|
| **Native rebuild required** | MMKV (`react-native-mmkv 3.3.3`), reanimated 4.3.4 / worklets 0.8.3, `styles.xml`, `app.json` permission, `MainApplication.kt`, `CallMessagingService.kt`, `expo-call-ui` Kotlin module, iOS `withIosVoip` AppDelegate changes, ML Kit iOS events. JS reload alone is **not enough**. |
| **Device-tested** | expo-image (AppImage), Batch-1 theme/nav-bar, reanimated debug build (tab swipe, attachment sheet, keyboard), MMKV native files present. Calls: many rows tested live on OnePlus ↔ web (see §3). |
| **NOT device-tested** | Much of the receipts/unread JS (only Babel-parsed + unit tests), gorhom sheets in light theme/iOS, iOS Swift (PushKit, ML Kit events — **not compiled**), release build of reanimated, in-notification Reply/Mark-as-read, app-icon badge, screen-share frames on web. |
| **Unit tests added** | `__tests__/*.test.js` (9 files, pure `node:test`, no RN needed): `node --test __tests__/` |
| **Do not commit** | `modules/expo-call-ui/android/build/**` (generated build output, shows as modified), `src-plugins-moduels.zip` (6.9 MB stray archive in the app root — looks like a backup, not part of the app). |

---

## 1. Theme & UI consistency (UI audit — Batch 1 "theme foundation")

Goal: WhatsApp-level consistent look; readable contrast in light + dark; one surface colour for popups.

| File | What was done |
|---|---|
| `src/contexts/ThemeContext.js` | Biggest change here. Added WCAG contrast helpers (luminance/contrast, memoised). New helpers `outgoingPaletteFor`, `sentBubbleBgFor`, `senderNameColorFor` (12 validated hues per theme), `withAlpha`; everything painted on the user's chosen outgoing-bubble colour (text, time, ticks, links) is now *derived* so any accent swatch stays readable. New tokens: `menuSurface`, `link`, `dangerText`, `tick.*`, `bubbleSentMeta`, `bubbleReceivedText`, `systemBg/Text/Border`, `dateChipBg`, `composerBg/Text/Placeholder`, `replyBarBg`, `chatBackground`, `disabledSurface/disabledText`. Light `placeHolderTextColor` `#a9a9a9 → #667781` (was 2.35:1). Theme + chat colour now stored through MMKV (`kvStorage`). `applyNativeScheme()` calls `Appearance.setColorScheme` on a manual theme choice so native chrome (dialogs, nav bar) follows the in-app theme. |
| `THEME_GUIDE.md` | Documented all new tokens, outgoing-bubble rule, type scale, bubble width rule, Batch-1 notes. |
| `App.js` | Removed the `react-native-paper` bridge (`ThemedPaperProvider`); added `runMigrationSweep()` (one-time AsyncStorage → MMKV copy, not awaited). |
| `android/app/src/main/res/values/styles.xml` | `enforceNavigationBarContrast` → `false` (it painted a grey scrim over the nav bar). **Re-apply after any `expo prebuild --clean`.** |
| `src/components/ThemedWebView.jsx` (new) | WebView for remote legal pages; dark mode inverts the light-only page before first paint, themed loader. **Delete `DARK_CSS` when the website gets real dark mode** (otherwise it double-inverts). |
| `src/screens/Privacy.jsx`, `src/screens/Term.jsx` | Now use `ThemedWebView`. |
| `src/calls/callDirectionMeta.js` | Connected-call colour `#1DAB61` → brand teal `#03b0a2`. |
| `src/components/MessageTicks.jsx` (new) | Single tick component (pending clock / sent ✓ / delivered ✓✓ grey / read ✓✓ blue / failed / cancelled; `variant="media"` for ticks over photos). Used by chat bubble, media overlay, chat-list and archived-list previews. |
| `src/components/MessageTypeIcon.jsx` (new) | Vector media-type icon (photo/video/audio/doc/location/contact) replacing the emoji marker in previews. |
| `ChatCard.jsx`, `ReplyBubble.jsx`, `ReplyPreviewBox.jsx`, `ChatList.jsx`, `ArchivedChats.jsx` | Use the new icon/tick components + tokens; unread time uses `link` colour (brand teal was 2.7:1); capped font scaling (`maxFontSizeMultiplier`); accessibility roles/labels. Reply quote bar/name colours now derived from bubble/sender palette (fixes bar vanishing when quoting yourself on an accent bubble). |
| `MentionText.jsx` | Mention colour = `link` token / bubble-derived (was hard-coded). |
| `AttachmentSheet.jsx`, `MenuPopover.jsx`, `ReactionBar.jsx`, `ScheduleTimePicker.jsx`, `StatusUnavailableModal.jsx`, `ProfilePreviewModal.jsx`, `ScanConfirmSheet.jsx`, `LinkDevice.jsx`, `CallDetailScreen.jsx`, `GroupInfo.jsx`, `ArchivedChats.jsx` | Hard-coded / `cardBackground` surfaces → `menuSurface`; danger text → `dangerText`. |
| `ChatWallpaper.jsx` | Dark wallpaper `#0B141A` (comment/behaviour aligned to token). |
| `ChatHeaderPresence.js` | Status text uses `link` / `secondaryTextColor` (was 2.3:1); back-button hit area ≥44×52; accessibility labels. |
| `ChatColorTheme.jsx` | Preview bubble now uses the same outgoing-palette rule as the real chat. |
| `UsernameEdit.jsx` | Disabled Save uses `disabledSurface/Text` instead of dimmed brand fill. |
| `StatusCreate.jsx` | Placeholder contrast 0.55 → 0.78 alpha. |
| `CallButtons.jsx`, `GroupCallButtons.jsx` | Accessibility role/label/state on call buttons; group menu uses `menuSurface`. |
| `RootNavigator.js` | `freezeOnBlur: true` — unfocused screens (e.g. chat list under an open chat) stop re-rendering. |
| `ChatScreen.jsx` (UI part) | Bubble width = `min(80% of row, 560dp)` via `useWindowDimensions` (rotation/tablet), outgoing ink/meta/tick/link derived from bubble colour, media-overlay tick tokens, reduced-motion (snap instead of spring). |

**Still pending (not done):** UI audit Batches 2–5 (navigation/back-gesture, shared Header/Button/Row/Menu/Dialog, per-screen, polish). Open questions are in `APP_UI_FULL_AUDIT_2026-10/REPORT.md` §9.

---

## 2. Library upgrades / performance (library audit C1–C8)

| File | What was done |
|---|---|
| `src/components/AppImage.jsx` (new) + `src/utils/imageCache.js` (new) | One image component on **expo-image**. Cache key = stable S3 object path (URL without presigned query), so re-signed URLs don't re-download. `recyclingKey` for list rows. **Never use for view-once media.** Logout clears the image cache. |
| ~34 files (screens/components listed in git diff: `CallAvatar`, `SelectPeopleSheet`, `AppBannerHost`, `GroupMemberSheet`, `GroupSenderAvatar`, `MediaGallery`, `MentionInput`, `StatusFeedRow`, `UserDetailsSheet`, `UserSearchRow`, `AddNewContact`, `AddUser`, `ChannelInfo`, `ForwardMessageScreen`, `MessageInfoScreen`, `ShareInboxScreen`, `AddGroupMembers`, `CreateGroup`, `EditGroup`, `GroupInfo`, `BlockedContacts`, `DeletedChatsSelector`, `Profile`, `Setting`, `UserB`, `NewCallScreen`, `TicketChat` …) | RN `<Image>` → `<AppImage>` (mechanical swap). |
| `src/services/kvStorage.js` (new) | **MMKV** storage with an AsyncStorage-compatible API. `deviceKv` (theme, language, translation cache, auto-download – survives logout) and `kv` (per-account: drafts, chat colour, media maps – wiped on logout/switch). Idempotent migration from AsyncStorage. |
| `autoDownloadSettings.js`, `chatDraftStore.js`, `Translate.js`, `ChatColorTheme.jsx`, `ThemeContext.js`, `sessionManager.js` | Moved to `kvStorage`. `sessionManager` clears the account store on logout (can keep media records for same-account return). |
| `src/components/AppSheet.jsx` (new) | `@gorhom/bottom-sheet` wrapper (drag-down, backdrop, Android back). `USE_GORHOM=false` rolls back to the old Modal. Used by `ReactionDetailSheet`, `ReactionPicker` (full emoji), `ReportBottomSheet` (handles keyboard height). AttachmentSheet + MenuPopover deliberately untouched. |
| `package.json` | Added `@gorhom/bottom-sheet 5.2.14`, `react-native-mmkv 3.3.3`; `react-native-reanimated 4.3.4` + `worklets 0.8.3` (moved **off** the Expo SDK pin on purpose — `expo install --check` will warn); Expo SDK 54 patch bumps (expo, constants, font, image-picker, notifications, screen-capture, updates); `react-native-get-random-values ^2.0.0 → ~1.11.0`. |
| `ChatScreen.jsx` (perf part) | Stable row renderer + per-row `live` signature so download ticks / voice-note position updates don't re-render every bubble ("slice 1"). No measurable gain on a small chat — needs a long-chat release-build check. |
| Parked / dropped | FlashList (regressed on ChatList pilot; package removed), other candidates deferred until a release-build baseline exists. |

---

## 3. Calling — Phase 2 hardening (call audit + call-push audit)

### 3a. Signalling / reconnect / glare (JS)
| File | What was done |
|---|---|
| `src/calls/CallProvider.jsx` (+321) | Peer-gone 5 s vs **own-network** 25 s reconnect windows (don't hang up before SDK rebuild at 12 s); end-cause (`endCode/endTrigger/endSource`) sent with cancel/reject/end so server CallTraces show who/why; media-plane decline on 1:1 waits for app-plane verdict (fixes sibling-tab decline killing an answered call); glare handling (dial someone who is calling you = answer their call); recheck after awaits so a landed ring is not overwritten; end-linger reset can't wipe a call-back; send persisted native Declines; ring-ack (`call:ringing`) → "Ringing…" UI. |
| `src/calls/native-engine/NativeCallingSDK.js` (+278) | `leaveRoom` only for a *different* room (re-join of same room no longer makes the web peer hang up); join-token freshness check + re-mint before join/resume; token provider; swallow ghost re-rings after decline (never auto-decline a genuine redial); `getStats` sampler every 10 s → call-log `qualityMetrics`; camera producer `disableTrackOnPause:false` (fixes frozen self-preview while ringing); screen-share: VP8 single layer + `_watchScreenSend` diagnostics (`[screen] outbound` log) with one retry. |
| `NativeCallEngine.js`, `engine/protocol.js` | `SET_TOKEN` command (apply fresh JWT in place), `APP_CALL_ID` correlation for server recording, re-register on a parked accept. |
| `callSignalService.js` | cancel/reject/end carry the end-cause fields. |
| `callMachine.js` | `ringingConfirmed` state. |
| `nativeCallService.js` | Strings "BaatCheet" → "TalksTry". |
| `Socket/socket.js` | Sends `voipEnv` (dev/prod APNs) with device register; `clearVoipToken()`. |

### 3b. Push-ring safety (Android native + iOS + JS) — IDs P-C-xx
| File | What was done |
|---|---|
| `src/calls/callPushGuards.js` (new, pure, unit-tested) | Decision rules shared by JS / Kotlin / Swift: session & recipient guard, stale-push classification on **server** time, re-invite after cancel (group/conference), etc. Keep the three languages in step when changing a rule. |
| `callSessionMarker.js` (new) + `sessionManager.js` + `freshInstallSweep.js` | Publish "who is signed in" to native (Keychain on iOS via secure-store, SharedPreferences on Android); `none` when signed out. A signed-out/other-account device no longer rings (P-C-04). Reinstall marks device signed-out. |
| `callServerClock.js` (new) | Learns server−device clock offset from a live socket ring, persisted + mirrored to native, so a fast phone clock doesn't silence live calls (P-C-16). |
| `modules/expo-call-ui/index.ts` + `ExpoCallUiModule.kt` (+182) + `CallActionReceiver.kt` | New native API: `setSessionMarker`, `setServerClockOffset`, `getPendingDeclines/clear` (Decline tapped while JS dead is **persisted** and sent when JS is up — P-C-06; stops the caller ringing the full ~40 s), `areNotificationsEnabled`, `isCallChannelEnabled`, `canUseFullScreenIntent`, `openFullScreenIntentSettings`, `getManufacturer`, group re-invite rule (P-C-12). Decline now also stops the ring service. |
| `CallMessagingService.kt` + `plugins/withCallFcmService.js` | Ring only if push is fresh (server clock) **and** for the signed-in user. (Plugin and Kotlin file carry the same code — keep in sync.) |
| `plugins/withIosVoip.js` (+167) | AppDelegate (Swift) reads Keychain session marker; VoIP push for signed-out/other user is reported to CallKit and ended immediately (Apple rule); non-ring VoIP payload types handled; invalidated-token note written to Keychain. **Swift not compiled here.** |
| `src/calls/services/voipPushService.js`, `src/utils/voipEnv.js` (new) | Derive APNs environment from provisioning profile; consume "token invalidated" note and stop re-sending a dead VoIP token. |
| `callReliabilityPolicy.js` (new, pure) + `callReliability.js` + `CallReliabilityGate.jsx` | Reliability prompt now shows for *any* problem: notifications off, calls channel off, Android 14+ full-screen-intent denied, battery exemption missing, known OEM Autostart (once per install). |
| `Redux/Services/navigationService.js` | Notification tap guard: a push addressed to another account (`recipientId`) doesn't open that chat under the current user. |

### 3c. In-call UX
| File | What was done |
|---|---|
| `CallControls.jsx` | **Screen-share chip** in the video row (Android only; iOS needs a ReplayKit extension). |
| `plugins/withWebrtcMediaProjection.js` (new), `MainApplication.kt`, `app.json` | Enables react-native-webrtc's MediaProjection foreground service (without it share "succeeds" but sends 0 frames) + `FOREGROUND_SERVICE_MEDIA_PROJECTION` permission (needs Play Console declaration + demo video). |
| `NativeVideoStage.jsx`, `CallOverlay.jsx`, `callChromeStore.js` (new) | Video-call controls auto-hide after 8 s, tap video to show/hide; shared screens render as their own feed (`<peer>#screen`). |
| `CallsScreen.jsx` | Web parity: consecutive calls with same peer/group on the same day collapse into one row "@name (4)", tap expands with direction/time/duration. |

---

## 4. Messaging, receipts & ticks (messaging audit M-xx, receipts audit T-A-xx)

| File | What was done |
|---|---|
| `src/contexts/RealtimeChatContext.js` (+1020) | **Backfill guard**: catch-up / seq-hole fills / edit replays of *older* messages no longer bump unread or drag the row (fixes read chats re-badging after app reopen and list rows jumping). Tick fixes: chat list matches a message by **every alias id** (server id, _id, temp id, client id); read/seen needs proof (named ids or `upToSeq ≥ lastMessage.seq`); flat `lastMessageStatus` kept in lockstep with `lastMessage.status`; peer read/delivered **watermark** lifts the list tick forward-only (T-A-02/03); batched receipt emits (A-13); one-owner-per-receipt emit guard. Mutation cursor moved to SQLite `sync_meta`. |
| `src/contexts/useChatLogic.js` (+547) | Read-all bounded by reader's synced seq (no more "now" timestamp blue-ing unseen messages); receipts only when app is foreground **and** screen focused, re-run when it becomes readable again (T-A-06); trailing read-all **flushed on unmount** instead of cancelled; `message:sync` continues while `hasMore` (A-07); messages carry every alias id to the list. |
| `src/services/ChatDatabase.js` (+598) | **DB V16**: downgrades own private `seen/read` rows above the peer read watermark and re-derives chat-list tick (old merge only ever moved up, so wrong blue stayed forever). **DB V17**: `edit_version` column. Early-receipt buffer (60 s) replayed at temp→server id swap (T-A-01). `upsertMessages` now **reports** `{committedIds, failedIds}` with bounded retry instead of swallowing failures. Delete-then-incoming hands over `local_uri` so downloaded media isn't "forgotten". |
| `src/utils/receiptStatus.js` (new, unit-tested) | Status rank / forward-only merge / owned statuses. |
| `ChatSocketProvider.js` | Message deleted-for-everyone also removes the tray notification. |
| `SqliteWriter.js` | Passes `editVersion` to the edit writer. |
| `ChatScreen.jsx` (logic part) | Cleaner send path (composer keeps typed text when offline), media-state rendering from the single local record. |

---

## 5. Push notifications (push audit P-A-xx)

| File | What was done |
|---|---|
| `src/utils/messagePushPolicy.js` (new, unit-tested) | Pure rules: `isPushForUser` (recipient guard), sender-privacy fields (`hideContact`, `@username`), inline-action eligibility. |
| `src/firebase/notificationModel.js` | Model keeps `recipientId`, sender privacy fields, `isViewOnce`. |
| `src/firebase/messageNotification.js` + `src/utils/keyedSerial.js` (new) | Per-chat serial queue so two pushes for the same chat can't overwrite each other's line (P-A-09); **inline Reply / Mark as read** actions (P-A-10); in-place update/removal of a line for edit/delete. |
| `src/firebase/messageNotificationActions.js` (new) | Handles Reply (optimistic SQLite row + durable outbox row + one REST attempt, worker retries; group via socket) and Mark-as-read from the notification, even when app is killed. |
| `src/firebase/callNotifee.js` | Routes message-notification action presses to the above (awaited so the headless task stays alive). |
| `src/firebase/fcmService.js` (+241) | Channels `groups` / `silent` created once; old-channel deletion now a **one-time flagged migration** (no longer on every JS import/headless wake); `dismissDeletedMessageNotification`; badge sync hooks. |
| `src/firebase/appBadge.js` (new) | App-icon badge = sum of `chats.unread_count` (event-driven, notifee). |

---

## 6. Offline / reconnect delivery

| File | What was done |
|---|---|
| `src/services/OutboxWorker.js` | NetInfo + socket-reconnect aware: while offline it does **not burn retry attempts** (A-08); wakes immediately on reconnect. |
| `src/utils/catchupChunks.js` (new, unit-tested) | Catch-up requests chunked (100 chats, server cap 200), most-recent-active first; `shouldCountOutboxFailure` rule. |
| `LocalStorageService.js` (+278) | All read-modify-write of the media maps serialized (3 album tiles finishing together used to erase each other's records); md5 computed *before* entering the lock. |

---

## 7. Message edit (edit audit E-A-xx)

| File | What was done |
|---|---|
| `src/utils/messageEditPolicy.js` (new, unit-tested) | Rule: sender may edit a text message only until the recipient has **read** it (server is authority; client derives from stored row, 15-min UX hint, 10 000-char cap). |
| `ChatDatabase.js` V17 + `SqliteWriter.js` | `edit_version` monotonic guard on every edit applier (stale edit can't overwrite a newer one). |

---

## 8. Media download state (stale iOS container paths)

| File | What was done |
|---|---|
| `src/utils/mediaLocalPaths.js` (new, unit-tested) | Re-base a stored `…/Documents/TalksTry/Media|Sent/…` path onto the *current* `documentDirectory` (iOS container UUID changes on update/restore). |
| `src/hooks/useMediaDownload.js`, `LocalStorageService.js`, `ChatScreen.jsx` | Verify the file the record points at; re-base + heal stale paths; if the file is truly gone drop the record so the bubble offers **Download again** (previously a permanent blank "downloaded" tile). Downloaded ⇔ file exists on *this* device (server `isMediaDownloaded` ignored on purpose). |

---

## 9. Device linking (QR → web)

| File | What was done |
|---|---|
| `features/device-linking/hooks/useDeviceLinking.js`, `constants.js`, `LinkingLoader.jsx`, `QRScannerScreen.jsx` | After scan the app holds "Connecting…" until the server's new `device:link:web:ready` event (30 s timeout → error); specific errors no longer masked by a generic one; new `BROWSER_ALREADY_LINKED` message; removed plaintext `webLinkedToken` write. (Backend + web counterparts are in `chat-backend` / `chat-website`.) |

---

## 10. Translation language-model download (pause / resume)

| File | What was done |
|---|---|
| `src/components/Translate.js` | States `downloading | paused | failed`; picking another language **pauses** (UI-level) and re-picking re-attaches to the in-flight native job and continues progress; timeout/offline → paused (not failed); NetInfo reconnect resumes; background sender-language downloads wait for the active pick. |
| `modules/expo-mlkit-translate/src/MlkitTranslate.ts` | Safe iOS listeners `onDownloadProgress` / `onModelDownloaded` (no-op on Android or old builds). |
| `src/screens/profiles/ChooseLanguage.jsx` | Smooth animated progress bar (eased run to 100%, no jump 60%→100%); a user-paused row stays paused even if ML Kit finishes it in the background. |
> ML Kit has **no pause/cancel API** — "pause" is UI-level only on the app (web has real byte-level resume).

---

## 11. New unit tests (`__tests__/`)

`callPushGuards`, `callReliabilityPolicy`, `catchupChunks`, `keyedSerial`, `mediaLocalPaths`, `messageEditPolicy`, `messagePushPolicy`, `receiptStatus`, `voipEnv` — run with `node --test __tests__/`.

---

## 12. Known gaps / needs follow-up

1. **Device matrix** for calls on release build, iOS (PushKit/CallKit Swift never compiled), and the screen-share-to-web frame issue (root cause of "Waiting for the shared screen…" still not confirmed — check the `[screen] outbound` logcat line).
2. **Backend must be deployed/restarted** for several features (`recipientId` in pushes, `editVersion`, `device:link:web:ready`, `call:ringing`, `upToSeq` read-all); the app is written to degrade safely with an older backend.
3. Receipts/unread/DB-migration (V16/V17) JS paths were verified by unit tests and SQL, **not on a device** — please smoke-test: open app after update, check chat-list ticks/unread, edit a message, kill-app Reply from notification.
4. UI audit Batches 2–5, FlashList retry (release build + 500-chat account), deferred push items (iOS collapse-id, Web Push) remain open.
5. Do not commit generated `modules/expo-call-ui/android/build/**` or `src-plugins-moduels.zip`.
