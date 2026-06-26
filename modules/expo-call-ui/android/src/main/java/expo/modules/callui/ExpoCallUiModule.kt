package expo.modules.callui

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

const val CHANNEL_ID = "calls_fullscreen"
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

// Process-wide bridge from the (static) BroadcastReceiver to the live JS module.
// When JS isn't running yet (cold start from a killed app), the action is queued
// and replayed via getInitialCallAction() once the module mounts.
object CallUiBus {
  @Volatile var module: ExpoCallUiModule? = null
  @Volatile var pending: Map<String, Any?>? = null
  // Set from JS (setCallActive) whenever a call is ringing/connecting/active. The
  // keyguard backstop uses it to know a foreground-over-lock is a legitimate call
  // surface (so it is NOT bounced behind the keyguard). Process-wide so it survives
  // the module being torn down/recreated across a cold start.
  @Volatile var callActive = false

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

  // Native full-screen "incoming call" cover. Drawn over the activity content the
  // instant MainActivity is launched/resumed for a call — BEFORE React Native
  // renders its first frame (the Splash route / last screen). This is the only way
  // to get WhatsApp-style INSTANT call UI: a JS cover can't paint over the native
  // resume flash of a backgrounded-but-alive app. Removed when JS signals the real
  // call overlay is up (hideCallLaunchCover), or by a safety timeout.
  private var callLaunchCover: View? = null
  private val mainHandler = Handler(Looper.getMainLooper())
  private var coverTimeout: Runnable? = null

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

    // Send the app BEHIND the keyguard: revoke show-over-keyguard, then move the
    // task to back so the system lock screen reasserts. Called when a call that
    // began on a LOCKED device ends or the user backs out of it — the user lands on
    // the lock screen, never the app. (JS: callNotifee.returnToLockScreen →
    // CallProvider finalizeEnd / leaveToLock.)
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
          activity.moveTaskToBack(true)
        }
      }
      Unit
    }

    Function("displayIncomingCall") { options: Map<String, Any?> ->
      appContext.reactContext?.let { display(it, options) }
    }

    Function("cancelIncomingCall") { callId: String ->
      appContext.reactContext?.let {
        NotificationManagerCompat.from(it).cancel(callId.hashCode())
      }
    }

    // ---- active-call ongoing foreground service (CallStyle.forOngoingCall) ----
    Function("startOngoingCall") { options: Map<String, Any?> ->
      val ctx = appContext.reactContext ?: return@Function
      val callId = (options["callId"] as? String)?.takeIf { it.isNotBlank() } ?: return@Function
      val name = options["callerName"] as? String
      val image = options["callerImage"] as? String
      val type = options["callType"] as? String ?: "audio"
      val startedAtMs = (options["startedAt"] as? Number)?.toLong() ?: 0L
      CallForegroundService.start(ctx, callId, name, image, type, startedAtMs)
    }

    Function("stopOngoingCall") {
      appContext.reactContext?.let { CallForegroundService.stop(it) }
    }

    // JS marks a call ringing/connecting/active (true) or fully idle (false). The
    // keyguard backstop (OnActivityEntersForeground) reads this so an active call's
    // UI is allowed over the lock screen while a non-call launch is bounced.
    Function("setCallActive") { active: Boolean ->
      CallUiBus.callActive = active
    }

    // NON-consuming peek of the launch intent: did a call full-screen-intent launch
    // this activity (killed/locked cold start)? Returns the caller info so JS can
    // paint the full-screen call UI from the VERY FIRST frame — before the Splash /
    // ChatList boot flow shows — eliminating the "last screen → splash → call UI"
    // flash. Unlike getInitialCallAction() it does NOT remove the extra, so the real
    // cold-start replay (consumeInitialNotifeeCall) still drives the live call.
    Function("peekInitialCallLaunch") {
      val intent = appContext.currentActivity?.intent
      if (intent?.hasExtra(EXTRA_CALL_ACTION) == true) {
        mapOf(
          "action" to intent.getStringExtra(EXTRA_CALL_ACTION),
          "callId" to intent.getStringExtra(EXTRA_CALL_ID),
          "callerId" to intent.getStringExtra(EXTRA_CALLER_ID),
          "callerName" to intent.getStringExtra(EXTRA_CALLER_NAME),
          "callerImage" to intent.getStringExtra(EXTRA_CALLER_IMAGE),
          "callType" to intent.getStringExtra(EXTRA_CALL_TYPE)
        )
      } else {
        null
      }
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

    // No-op kept for JS compatibility (the native caller-name cover was removed in
    // favour of showing the real React-Native call UI directly).
    Function("hideCallLaunchCover") { hideCallLaunchCover() }

    // ---- KEYGUARD BACKSTOP (deterministic lock-screen security) ----
    // MainActivity carries a static android:showWhenLocked (so a call's full-screen
    // intent can draw over the lock screen). The side effect is that ANY launch of
    // the single-Activity app — a message-notification tap, a stale call FSI, an
    // OS relaunch — would otherwise paint the whole app (ChatList) over the keyguard
    // and let the user interact while locked. This guard runs every time the app
    // enters the foreground: if the keyguard is locked AND this is NOT a call (the
    // launch intent carries no call action AND no call is currently active), it
    // sends the task BEHIND the keyguard so the system lock screen reasserts — the
    // app can never be used over the lock screen for a non-call reason. A genuine
    // call is exempt (call FSI intents carry EXTRA_CALL_ACTION; an in-progress call
    // sets CallUiBus.callActive via setCallActive), so call-over-lock keeps working.
    OnActivityEntersForeground {
      appContext.currentActivity?.let { activity ->
        val km = activity.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
        val locked = km?.isKeyguardLocked ?: false
        val hasCallIntent = activity.intent?.hasExtra(EXTRA_CALL_ACTION) == true
        if (locked && !hasCallIntent && !CallUiBus.callActive) {
          activity.runOnUiThread { activity.moveTaskToBack(true) }
        }
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

  // Draw a full-screen native "incoming call" cover over the activity content the
  // instant the app is launched/resumed for a call — so the user sees the call, not
  // the last screen or the JS Splash. Removed by hideCallLaunchCover() once the RN
  // call overlay is up, or by a safety timeout.
  private fun showCallLaunchCoverFor(intent: Intent?) {
    if (intent?.hasExtra(EXTRA_CALL_ACTION) != true) return
    val activity = appContext.currentActivity ?: return
    val name = intent.getStringExtra(EXTRA_CALLER_NAME)?.takeIf { it.isNotBlank() } ?: "Incoming call"
    val isVideo = (intent.getStringExtra(EXTRA_CALL_TYPE) ?: "audio") == "video"
    activity.runOnUiThread {
      if (callLaunchCover != null) return@runOnUiThread
      val root = (activity.findViewById<View>(android.R.id.content) as? ViewGroup) ?: return@runOnUiThread
      val column = LinearLayout(activity).apply {
        orientation = LinearLayout.VERTICAL
        gravity = Gravity.CENTER
      }
      column.addView(TextView(activity).apply {
        text = name
        setTextColor(Color.WHITE)
        textSize = 26f
        gravity = Gravity.CENTER
      })
      column.addView(TextView(activity).apply {
        text = if (isVideo) "Incoming video call" else "Incoming voice call"
        setTextColor(Color.parseColor("#8AA0AB"))
        textSize = 15f
        gravity = Gravity.CENTER
      })
      val cover = FrameLayout(activity).apply {
        setBackgroundColor(Color.parseColor("#0B141A"))
        isClickable = true   // swallow touches so the app behind can't be used
        isFocusable = true
        addView(
          column,
          FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT
          ).apply { gravity = Gravity.CENTER }
        )
      }
      root.addView(
        cover,
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      )
      callLaunchCover = cover
      // Never let the cover get stuck if JS never mounts the call UI (stale launch,
      // call already cancelled, etc.).
      coverTimeout?.let { mainHandler.removeCallbacks(it) }
      val r = Runnable { hideCallLaunchCover() }
      coverTimeout = r
      mainHandler.postDelayed(r, 8000)
    }
  }

  private fun hideCallLaunchCover() {
    mainHandler.post {
      coverTimeout?.let { mainHandler.removeCallbacks(it) }
      coverTimeout = null
      val c = callLaunchCover ?: return@post
      (c.parent as? ViewGroup)?.removeView(c)
      callLaunchCover = null
    }
  }

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

  // Instance entry (JS `displayIncomingCall`) — delegates to the static renderer
  // so the SAME CallStyle notification can be posted from a native FCM service
  // (CallMessagingService) WITHOUT the React Native JS runtime being up. Both
  // paths key the notification on callId.hashCode(), so a later JS re-render just
  // refreshes the same notification — never a duplicate.
  private fun display(ctx: Context, options: Map<String, Any?>) {
    // Re-arm show-when-locked TRUE on the (possibly backgrounded) activity. When the
    // app is alive but NOT in a call we revoke the flag at runtime (CallProvider →
    // setShowWhenLocked(false)) / returnToLockScreen() also clears it, and that
    // value PERSISTS on the live Activity. Without resetting it here, THIS call's
    // full-screen intent would light the screen but the call UI couldn't draw over
    // the keyguard — the "screen turns on, no call UI" bug. Killed app → no activity
    // → the manifest android:showWhenLocked handles it (nothing to re-arm).
    appContext.currentActivity?.let { act ->
      act.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          act.setShowWhenLocked(true)
          act.setTurnScreenOn(true)
        }
      }
    }
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
