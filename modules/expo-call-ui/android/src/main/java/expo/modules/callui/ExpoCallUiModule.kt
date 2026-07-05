package expo.modules.callui

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Bumped to _v2 (APP-13): a notification channel is IMMUTABLE once created, so
// adding the ringtone sound + DND bypass requires a new channel id — the old
// "calls_fullscreen" channel keeps whatever settings it was first created with.
const val CHANNEL_ID = "calls_fullscreen_v2"
const val EVENT_NAME = "onCallAction"
// Emitted whenever the keyguard locks/unlocks (screen off, screen on while
// locked, or user-present unlock). Drives the privacy overlay: MainActivity
// carries showWhenLocked (for incoming calls), so waking a locked device makes
// AppState report 'active' even though the keyguard is still up — JS can't tell
// the device is locked from AppState alone, so we tell it natively.
const val LOCK_EVENT = "onLockStateChange"

const val ACTION_ANSWER = "expo.modules.callui.ANSWER"
const val ACTION_DECLINE = "expo.modules.callui.DECLINE"
const val ACTION_HANGUP = "expo.modules.callui.HANGUP"

const val EXTRA_CALL_ACTION = "callAction"
const val EXTRA_CALL_ID = "callId"
const val EXTRA_CALLER_ID = "callerId"
const val EXTRA_CALLER_NAME = "callerName"
const val EXTRA_CALLER_IMAGE = "callerImage"
const val EXTRA_CALL_TYPE = "callType"
const val EXTRA_STARTED_AT = "startedAt"
// "ringing" (outgoing call dialed, not yet answered) or "ongoing" (connected).
const val EXTRA_STATE = "state"

// Process-wide bridge from the (static) BroadcastReceiver to the live JS module.
// When JS isn't running yet (cold start from a killed app), the action is queued
// and replayed via getInitialCallAction() once the module mounts.
object CallUiBus {
  @Volatile var module: ExpoCallUiModule? = null
  @Volatile var pending: Map<String, Any?>? = null

  fun dispatch(payload: Map<String, Any?>) {
    val m = module
    if (m != null) m.emit(payload) else pending = payload
  }
}

class ExpoCallUiModule : Module() {
  // Runtime receiver for screen/keyguard transitions. SCREEN_ON/OFF and
  // USER_PRESENT cannot be declared in the manifest — they must be registered
  // at runtime, which is why this lives in the module rather than a static
  // <receiver>.
  private var lockReceiver: BroadcastReceiver? = null

  // True while a call is ringing/connecting/active. Gates the keyguard backstop
  // (OnActivityEntersForeground) so app content is bounced behind the lock screen
  // when no call justifies showing over it.
  @Volatile private var callActive: Boolean = false

  override fun definition() = ModuleDefinition {
    Name("ExpoCallUi")
    Events(EVENT_NAME, LOCK_EVENT)

    Function("isAvailable") { true }

    // True while the keyguard is up (device locked) — used to keep the privacy
    // overlay on even when showWhenLocked has made AppState report 'active'.
    Function("isDeviceLocked") {
      val ctx = appContext.reactContext ?: return@Function false
      val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      km?.isKeyguardLocked ?: false
    }

    // Turn the activity's show-over-the-keyguard ability on/off at runtime. The
    // manifest sets it true (so a COLD-START incoming call can show over the lock
    // screen), but for a running app we keep it OFF whenever there is no call so
    // that locking the phone drops the app BEHIND the keyguard — the user sees the
    // normal system lock screen, never the app (or any overlay) over it. Turned
    // back on only while a call is in progress (LK6). API 27+ uses the proper
    // setShowWhenLocked/setTurnScreenOn; older devices fall back to window flags.
    Function("setShowWhenLocked") { show: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      activity.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(show)
          activity.setTurnScreenOn(show)
        } else {
          @Suppress("DEPRECATION")
          val flags = WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
          if (show) activity.window.addFlags(flags) else activity.window.clearFlags(flags)
        }
      }
    }

    Function("displayIncomingCall") { options: Map<String, Any?> ->
      appContext.reactContext?.let { display(it, options) }
    }

    Function("cancelIncomingCall") { callId: String ->
      appContext.reactContext?.let {
        NotificationManagerCompat.from(it).cancel(callId.hashCode())
      }
      postedIncomingIds.remove(callId.hashCode())
    }

    // Dismiss EVERY incoming-call notification we've posted (JS calls this on
    // answer/end). Because the live call state's id can drift from the id the
    // notification was posted with, cancelling one-by-one can miss — so we track
    // every posted incoming notification id and clear them all here (APP-3).
    Function("cancelAllIncomingCalls") {
      appContext.reactContext?.let { cancelAllIncoming(it) }
    }

    // Send the app behind the keyguard: drop show-when-locked + move the task to
    // back so the system lock screen reasserts. Used when a call that arrived /
    // ran on a LOCKED device ends or is minimized — the user must land on the lock
    // screen, never inside the app (APP-3).
    Function("returnToLockScreen") {
      appContext.currentActivity?.let { activity ->
        activity.runOnUiThread {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            activity.setShowWhenLocked(false)
            activity.setTurnScreenOn(false)
          } else {
            @Suppress("DEPRECATION")
            activity.window.clearFlags(
              WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or
                WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
            )
          }
          try { activity.moveTaskToBack(true) } catch (_: Exception) {}
        }
      }
      Unit
    }

    // Track whether a call is ringing/connecting/active. While true the app may
    // legitimately show over the lock screen (the call UI); while false (idle) the
    // keyguard backstop below bounces any over-keyguard foreground behind the lock
    // screen so app content never leaks over it (APP-3).
    Function("setCallActive") { active: Boolean ->
      callActive = active
    }

    // Non-consuming peek of the launch intent: was the app cold-started by a call
    // full-screen intent? Returns the call payload WITHOUT clearing the marker or
    // dismissing the notification (unlike getInitialCallAction), so the JS
    // ColdStartCallCover can paint the incoming-call screen from the first frame
    // while getInitialCallAction still drives the real accept/incoming action once
    // CallProvider mounts (APP-3 / APP-14).
    Function("peekInitialCallLaunch") {
      peekCallIntent(appContext.currentActivity?.intent)
    }

    // The instant cold-start cover is a JS overlay (ColdStartCallCover); there is
    // no native cover view to remove, so this is a safe no-op kept for API
    // symmetry with the JS bridge (APP-3).
    Function("hideCallLaunchCover") {
      // no-op — the cover lives in React Native (ColdStartCallCover).
    }

    // ---- background-delivery reliability (OEM battery / autostart) ----
    // On many OEM skins (MIUI, FuntouchOS, ColorOS, …) a killed/rebooted app is
    // blocked from starting in the background, so the high-priority incoming-call
    // FCM push is dropped and the phone never rings until the app is opened once
    // ("device restart ke baad call/notification nahi aata"). The two user-grantable
    // escapes are (1) exempt the app from battery optimization and (2) enable OEM
    // "Autostart". These helpers let JS surface a one-time onboarding that takes the
    // user straight to those toggles.

    // True when the app is already exempt from Doze battery optimization (or on
    // pre-M where the concept doesn't exist). When false, background FCM delivery
    // can be throttled/killed and the onboarding should be offered.
    Function("isIgnoringBatteryOptimizations") {
      val ctx = appContext.reactContext ?: return@Function true
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@Function true
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      pm?.isIgnoringBatteryOptimizations(ctx.packageName) ?: true
    }

    // Open the system dialog asking the user to exempt THIS app from battery
    // optimization. Needs the REQUEST_IGNORE_BATTERY_OPTIMIZATIONS permission
    // (declared in this module's manifest). Returns true if a screen was launched.
    Function("requestDisableBatteryOptimization") {
      val ctx = appContext.reactContext ?: return@Function false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return@Function false
      try {
        launchExternal(ctx, Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
          data = Uri.parse("package:" + ctx.packageName)
        })
        true
      } catch (_: Exception) {
        // Some OEMs / Play builds reject the direct request — fall back to the
        // battery-optimization LIST so the user can still find the toggle.
        try {
          launchExternal(ctx, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
          true
        } catch (_: Exception) { false }
      }
    }

    // Open the OEM "Autostart" / "Background start" manager when we can identify
    // one, else the app's system settings details page (where autostart usually
    // lives on stock-ish ROMs). Returns true if a manufacturer-specific autostart
    // screen was opened (so JS can tailor its instructions), false if it fell back.
    Function("openAutoStartSettings") {
      val ctx = appContext.reactContext ?: return@Function false
      val opened = tryOpenAutoStart(ctx)
      if (!opened) openAppDetails(ctx)
      opened
    }

    Function("getManufacturer") { Build.MANUFACTURER ?: "" }

    // ---- active-call ongoing foreground service (CallStyle.forOngoingCall) ----
    Function("startOngoingCall") { options: Map<String, Any?> ->
      val ctx = appContext.reactContext ?: return@Function
      val callId = (options["callId"] as? String)?.takeIf { it.isNotBlank() } ?: return@Function
      val name = options["callerName"] as? String
      val image = options["callerImage"] as? String
      val type = options["callType"] as? String ?: "audio"
      val startedAtMs = (options["startedAt"] as? Number)?.toLong() ?: 0L
      val state = options["state"] as? String ?: "ongoing"
      CallForegroundService.start(ctx, callId, name, image, type, startedAtMs, state)
    }

    Function("stopOngoingCall") {
      appContext.reactContext?.let { CallForegroundService.stop(it) }
    }

    Function("getInitialCallAction") {
      // 1) An action queued by the Decline receiver (best-effort, rarely used).
      CallUiBus.pending?.let { CallUiBus.pending = null; return@Function it }
      // 2) Cold start: the launch intent extras (Answer / full-screen / body tap —
      //    all are getActivity intents, so the activity launch is system-trusted
      //    and reliable, unlike a BroadcastReceiver startActivity which Android 10+
      //    blocks as a background activity start).
      readCallIntent(appContext.currentActivity?.intent)
    }

    // Alive app (e.g. backgrounded) re-launched by an Answer / body / full-screen
    // tap → the new intent is delivered here; route it straight into JS.
    OnNewIntent { intent ->
      readCallIntent(intent)?.let { emit(it) }
    }

    // Keyguard backstop (APP-3): if the activity comes to the foreground OVER the
    // lock screen while NO call is active, bounce it back behind the keyguard so
    // app content can't leak over the lock screen (MainActivity carries
    // showWhenLocked so it can resume over the keyguard for calls). During a call
    // (callActive) the over-keyguard foreground is legitimate — leave it.
    OnActivityEntersForeground {
      if (callActive) return@OnActivityEntersForeground
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      if (km?.isKeyguardLocked == true) {
        try { activity.moveTaskToBack(true) } catch (_: Exception) {}
      }
    }

    OnCreate {
      CallUiBus.module = this@ExpoCallUiModule
      registerLockReceiver()
    }
    OnDestroy {
      if (CallUiBus.module === this@ExpoCallUiModule) CallUiBus.module = null
      unregisterLockReceiver()
    }
  }

  fun emit(payload: Map<String, Any?>) = sendEvent(EVENT_NAME, payload)

  private fun emitLock(locked: Boolean) = sendEvent(LOCK_EVENT, mapOf("locked" to locked))

  private fun registerLockReceiver() {
    val ctx = appContext.reactContext ?: return
    if (lockReceiver != null) return
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(c: Context?, intent: Intent?) {
        val km = c?.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val locked = when (intent?.action) {
          // Screen turned off → about to be locked: protect immediately.
          Intent.ACTION_SCREEN_OFF -> true
          // Successful unlock → safe to reveal.
          Intent.ACTION_USER_PRESENT -> false
          // Woken while still locked (the showWhenLocked-over-keyguard case):
          // keep protecting until USER_PRESENT.
          Intent.ACTION_SCREEN_ON -> km?.isKeyguardLocked ?: false
          else -> km?.isKeyguardLocked ?: false
        }
        emitLock(locked)
      }
    }
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_USER_PRESENT)
    }
    ctx.registerReceiver(receiver, filter)
    lockReceiver = receiver
  }

  private fun unregisterLockReceiver() {
    val ctx = appContext.reactContext
    val r = lockReceiver ?: return
    if (ctx != null) {
      try { ctx.unregisterReceiver(r) } catch (_: Exception) { /* already gone */ }
    }
    lockReceiver = null
  }

  // Launch an external settings/system intent from a (possibly non-activity)
  // context — prefers the current activity, else adds NEW_TASK so it still starts.
  private fun launchExternal(ctx: Context, intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
    } else {
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      ctx.startActivity(intent)
    }
  }

  // Best-effort: try the known OEM autostart components for this device and launch
  // the FIRST that actually resolves (guarded by resolveActivity + try/catch so an
  // unexported/absent component on another brand just falls through). Returns true
  // when one opened.
  private fun tryOpenAutoStart(ctx: Context): Boolean {
    val components = listOf(
      // Xiaomi / MIUI / Redmi / POCO
      "com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity",
      // Vivo / FuntouchOS / iQOO
      "com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
      "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity",
      "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager",
      // Oppo / ColorOS / realme
      "com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
      "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
      "com.oppo.safe" to "com.oppo.safe.permission.startup.StartupAppListActivity",
      // Huawei / Honor
      "com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity",
      "com.huawei.systemmanager" to "com.huawei.systemmanager.optimize.process.ProtectActivity",
      // Letv
      "com.letv.android.letvsafe" to "com.letv.android.letvsafe.AutobootManageActivity",
      // Asus
      "com.asus.mobilemanager" to "com.asus.mobilemanager.MainActivity"
    )
    for ((pkg, cls) in components) {
      try {
        val intent = Intent().apply {
          component = ComponentName(pkg, cls)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        // Attempt the launch directly rather than gating on resolveActivity():
        // Android 11+ package-visibility filtering hides these OEM security-center
        // components, so resolveActivity() returns null even when the screen is
        // launchable. The package names are brand-specific (com.miui.* only on
        // Xiaomi, com.vivo.* only on vivo, …) so there is no cross-brand false
        // match; a missing/unexported component just throws and we try the next.
        launchExternal(ctx, intent)
        return true
      } catch (_: Exception) { /* not this OEM / not launchable — try the next */ }
    }
    return false
  }

  // Fallback: the app's own system settings page (App info), where "Autostart" /
  // "Battery" / "Allow background activity" toggles live on most ROMs.
  private fun openAppDetails(ctx: Context) {
    try {
      launchExternal(ctx, Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
        data = Uri.parse("package:" + ctx.packageName)
      })
    } catch (_: Exception) {}
  }

  // Extract a call action from a launch/new intent (Answer → "accept",
  // full-screen / body → "incoming"), consume the marker so it can't replay, and
  // dismiss the notification now that its action is being handled.
  private fun readCallIntent(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    val action = intent.getStringExtra(EXTRA_CALL_ACTION) ?: return null
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return null
    intent.removeExtra(EXTRA_CALL_ACTION)
    appContext.reactContext?.let { NotificationManagerCompat.from(it).cancel(callId.hashCode()) }
    return mapOf(
      "action" to action,
      "callId" to callId,
      "callerId" to intent.getStringExtra(EXTRA_CALLER_ID),
      "callerName" to intent.getStringExtra(EXTRA_CALLER_NAME),
      "callerImage" to intent.getStringExtra(EXTRA_CALLER_IMAGE),
      "callType" to intent.getStringExtra(EXTRA_CALL_TYPE)
    )
  }

  // NON-consuming read of a launch intent's call action — same fields as
  // readCallIntent but it does NOT strip the marker or dismiss the notification,
  // so the cold-start cover can peek repeatedly until the real call state mounts
  // (APP-3). Returns null when the launch wasn't a call.
  private fun peekCallIntent(intent: Intent?): Map<String, Any?>? {
    if (intent == null) return null
    val action = intent.getStringExtra(EXTRA_CALL_ACTION) ?: return null
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return null
    return mapOf(
      "action" to action,
      "callId" to callId,
      "callerId" to intent.getStringExtra(EXTRA_CALLER_ID),
      "callerName" to intent.getStringExtra(EXTRA_CALLER_NAME),
      "callerImage" to intent.getStringExtra(EXTRA_CALLER_IMAGE),
      "callType" to intent.getStringExtra(EXTRA_CALL_TYPE)
    )
  }

  // Instance entry (JS `displayIncomingCall`) — delegates to the static renderer
  // so the SAME CallStyle notification can be posted from a native FCM service
  // (CallMessagingService) WITHOUT the React Native JS runtime being up. Both
  // paths key the notification on callId.hashCode(), so a later JS re-render just
  // refreshes the same notification — never a duplicate.
  private fun display(ctx: Context, options: Map<String, Any?>) {
    render(
      ctx,
      options["callId"] as? String ?: return,
      options["callerId"] as? String,
      (options["callerName"] as? String)?.takeIf { it.isNotBlank() } ?: "Incoming call",
      options["callerImage"] as? String,
      options["callType"] as? String ?: "audio"
    )
  }

  companion object {
    // Notification ids (callId.hashCode()) of every incoming-call notification
    // currently posted, so cancelAllIncomingCalls can dismiss them all even when
    // the live call state's id has drifted from the posted id (APP-3).
    private val postedIncomingIds = java.util.Collections.synchronizedSet(mutableSetOf<Int>())

    // Dismiss every posted incoming-call notification and clear the tracking set.
    fun cancelAllIncoming(ctx: Context) {
      val nm = NotificationManagerCompat.from(ctx)
      val ids = synchronized(postedIncomingIds) { postedIncomingIds.toList() }
      ids.forEach { try { nm.cancel(it) } catch (_: Exception) {} }
      postedIncomingIds.clear()
    }

    fun pendingFlags(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      else PendingIntent.FLAG_UPDATE_CURRENT

    // Dismiss the incoming-call notification natively (caller hung up / timed
    // out). Called by the FCM service on a `type:'call_cancel'` push so a
    // killed/backgrounded callee's ringing notification clears INSTANTLY, without
    // waiting for the JS bridge to cold-start.
    fun cancelIncoming(ctx: Context, callId: String?) {
      if (callId.isNullOrBlank()) return
      try { NotificationManagerCompat.from(ctx).cancel(callId.hashCode()) } catch (_: Exception) {}
      postedIncomingIds.remove(callId.hashCode())
    }

    // Map a raw FCM `data` payload to a native CallStyle render. Called by the
    // native FirebaseMessagingService the instant a `type:'call'` push arrives —
    // BEFORE the RN bridge cold-starts — so a killed/locked phone rings WhatsApp-
    // fast instead of waiting seconds for JS. Defensive: any missing field falls
    // back; a blank callId is ignored.
    fun renderIncoming(ctx: Context, data: Map<String, String?>) {
      val callId = data["callId"]?.takeIf { it.isNotBlank() } ?: return
      render(
        ctx,
        callId,
        data["callerId"],
        data["callerName"]?.takeIf { it.isNotBlank() } ?: "Incoming call",
        data["callerImage"],
        data["callType"] ?: "audio"
      )
    }

    // The actual CallStyle (green Answer / red Decline) notification + full-screen
    // intent. Static so both the JS module and the native FCM service can post it.
    fun render(
      ctx: Context, callId: String, callerId: String?, callerName: String,
      callerImage: String?, callType: String
    ) {
      val isVideo = callType == "video"
      ensureChannel(ctx)

      val person = Person.Builder().setName(callerName).setImportant(true).build()

      // Answer LAUNCHES the app directly (getActivity) — the same system-trusted
      // path as the body/full-screen tap — so it reliably navigates to the call
      // screen. (A getBroadcast→startActivity trampoline is blocked by Android 10+
      // background-activity-start limits, which is why the Answer button used to
      // not open the app.)
      val answerIntent = PendingIntent.getActivity(
        ctx, (callId + "answer").hashCode(),
        launchIntent(ctx, "accept", callId, callerId, callerName, callerImage, callType),
        pendingFlags()
      )
      // Decline does NOT open the app — just dismiss + reject (best-effort).
      val declineIntent = PendingIntent.getBroadcast(
        ctx, (callId + "decline").hashCode(),
        receiverIntent(ctx, ACTION_DECLINE, callId, callerId, callerName, callerImage, callType),
        pendingFlags()
      )
      val fullScreenIntent = PendingIntent.getActivity(
        ctx, (callId + "fsi").hashCode(),
        launchIntent(ctx, "incoming", callId, callerId, callerName, callerImage, callType),
        pendingFlags()
      )

      var smallIcon = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
      if (smallIcon == 0) smallIcon = android.R.drawable.sym_action_call

      val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
        .setSmallIcon(smallIcon)
        .setContentTitle(callerName)
        .setContentText(if (isVideo) "Incoming video call" else "Incoming voice call")
        .setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(fullScreenIntent)
        .setFullScreenIntent(fullScreenIntent, true)
        .setStyle(
          NotificationCompat.CallStyle.forIncomingCall(person, declineIntent, answerIntent)
            .setIsVideo(isVideo)
        )

      try {
        NotificationManagerCompat.from(ctx).notify(callId.hashCode(), builder.build())
        postedIncomingIds.add(callId.hashCode())
      } catch (_: SecurityException) {
        // POST_NOTIFICATIONS not granted — nothing we can do; ignore.
      }
    }

    private fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) != null) return
      val channel = NotificationChannel(CHANNEL_ID, "Incoming Calls", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Full-screen incoming voice and video calls"
        setShowBadge(false)
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 900, 700, 900)
        lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
        // Ring like a real phone call (APP-13): a ringtone-class sound played with
        // the ringtone usage so it's loud + loops on the call notification, and
        // bypass Do-Not-Disturb so an incoming call still rings in DND (WhatsApp
        // parity). The notifee fallback channel already sets these.
        setBypassDnd(true)
        val ringtone = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        if (ringtone != null) {
          val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
          setSound(ringtone, attrs)
        }
      }
      nm.createNotificationChannel(channel)
    }

    private fun receiverIntent(
      ctx: Context, action: String, callId: String, callerId: String?,
      name: String, image: String?, type: String
    ) = Intent(ctx, CallActionReceiver::class.java).apply {
      this.action = action
      putExtra(EXTRA_CALL_ID, callId)
      putExtra(EXTRA_CALLER_ID, callerId)
      putExtra(EXTRA_CALLER_NAME, name)
      putExtra(EXTRA_CALLER_IMAGE, image)
      putExtra(EXTRA_CALL_TYPE, type)
    }

    // Intent that (re)launches the app's main activity carrying the call action,
    // read back by getInitialCallAction() once JS boots.
    fun launchIntent(
      ctx: Context, action: String, callId: String, callerId: String?,
      name: String, image: String?, type: String
    ): Intent {
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: Intent()
      return launch.apply {
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        putExtra(EXTRA_CALL_ACTION, action)
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_CALLER_ID, callerId)
        putExtra(EXTRA_CALLER_NAME, name)
        putExtra(EXTRA_CALLER_IMAGE, image)
        putExtra(EXTRA_CALL_TYPE, type)
      }
    }
  }
}
