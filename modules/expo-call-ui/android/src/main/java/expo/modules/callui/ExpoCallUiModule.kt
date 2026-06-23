package expo.modules.callui

import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

const val CHANNEL_ID = "calls_fullscreen"
const val EVENT_NAME = "onCallAction"

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

  fun dispatch(payload: Map<String, Any?>) {
    val m = module
    if (m != null) m.emit(payload) else pending = payload
  }
}

class ExpoCallUiModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoCallUi")
    Events(EVENT_NAME)

    Function("isAvailable") { true }

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

    // ---- lock-screen security (WhatsApp-style isolation) ----
    // True when the device is currently locked (keyguard showing). Recorded at
    // call arrival so we only apply locked-call restrictions to calls that began
    // on a locked device.
    Function("isDeviceLocked") {
      val ctx = appContext.reactContext ?: return@Function false
      val km = ctx.getSystemService(Context.KEYGUARD_SERVICE) as? KeyguardManager
      km?.isKeyguardLocked ?: false
    }

    // Runtime override of the manifest android:showWhenLocked. We keep the manifest
    // flag true so the call reliably appears OVER the keyguard on launch, then
    // revoke it at runtime (show=false) the moment the user leaves the call.
    Function("setShowWhenLocked") { show: Boolean ->
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(show)
          activity.setTurnScreenOn(show)
        }
      }
      Unit
    }

    // Send the app BEHIND the keyguard: revoke show-when-locked, then move the task
    // to back so the system lock screen reasserts. Called when a call that started
    // on a locked device ends or the user backs out of it.
    Function("returnToLockScreen") {
      val activity = appContext.currentActivity
      activity?.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          activity.setShowWhenLocked(false)
          activity.setTurnScreenOn(false)
        }
        activity.moveTaskToBack(true)
      }
      Unit
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

    OnCreate { CallUiBus.module = this@ExpoCallUiModule }
    OnDestroy { if (CallUiBus.module === this@ExpoCallUiModule) CallUiBus.module = null }
  }

  fun emit(payload: Map<String, Any?>) = sendEvent(EVENT_NAME, payload)

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

  private fun display(ctx: Context, options: Map<String, Any?>) {
    val callId = options["callId"] as? String ?: return
    val callerId = options["callerId"] as? String
    val callerName = (options["callerName"] as? String)?.takeIf { it.isNotBlank() } ?: "Incoming call"
    val callerImage = options["callerImage"] as? String
    val callType = options["callType"] as? String ?: "audio"
    val isVideo = callType == "video"

    // Re-arm show-when-locked TRUE on the (possibly backgrounded) activity. A prior
    // locked call's returnToLockScreen() set it FALSE to re-protect the app; without
    // resetting it here, the full-screen intent for THIS new call would light the
    // screen but the call UI couldn't draw over the keyguard ("screen on, no UI").
    // When the app is killed there's no activity → the manifest flag handles it.
    appContext.currentActivity?.let { act ->
      act.runOnUiThread {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
          act.setShowWhenLocked(true)
          act.setTurnScreenOn(true)
        }
      }
    }

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

  companion object {
    fun pendingFlags(): Int =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
      else PendingIntent.FLAG_UPDATE_CURRENT

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
