package expo.modules.callui

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.content.ContextCompat

/**
 * Active-call (ongoing) foreground service — the WhatsApp-style persistent call
 * notification shown for the whole duration of a CONNECTED call. It carries:
 *   - caller name + (optional) round avatar
 *   - a live duration chronometer (counts up from the answer time)
 *   - a voice/video affordance (CallStyle.forOngoingCall + setIsVideo)
 *   - a red "Hang up" action
 *
 * Tapping the body re-opens the app on the active-call screen (a getActivity
 * PendingIntent — the same system-trusted launch path used by the incoming
 * CallStyle notification; NOT a broadcast→startActivity trampoline, which
 * Android 10+ blocks as a background activity start). Hang up is a broadcast to
 * CallActionReceiver (no activity launch needed), which stops this service and
 * dispatches 'hangup' into JS.
 *
 * Runs as a foreground service (type microphone, +camera for video) so the OS
 * keeps the call's mic/camera capture alive while the app is backgrounded. The
 * service is started from the foreground (the call connects while the activity is
 * up), so the Android 12+ background-FGS-start restriction does not apply.
 */
class CallForegroundService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }

    val callId = intent?.getStringExtra(EXTRA_CALL_ID)
    if (callId.isNullOrBlank()) {
      stopSelf()
      return START_NOT_STICKY
    }
    val name = intent.getStringExtra(EXTRA_CALLER_NAME)?.takeIf { it.isNotBlank() } ?: "Ongoing call"
    val image = intent.getStringExtra(EXTRA_CALLER_IMAGE)
    val type = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "audio"
    val isVideo = type == "video"
    // Wall-clock ms when the call was answered; 0 → count from now.
    val startedAtMs = intent.getLongExtra(EXTRA_STARTED_AT, 0L)

    val notification = buildNotification(callId, name, image, isVideo, startedAtMs)
    val promoted = startForegroundWithType(notification, isVideo)
    if (!promoted) {
      // Could not become a foreground service (e.g. a microphone-type FGS start
      // rejected on Android 12+). We MUST NOT keep a started-but-not-foreground
      // service alive — Android's 5s "did not call startForeground" watchdog would
      // crash the whole app and drop the live call. Stop immediately; the in-app
      // call UI still shows the timer, so the only thing lost is the status-bar
      // notification — never the call.
      stopSelf()
      return START_NOT_STICKY
    }
    return START_STICKY
  }

  private fun buildNotification(
    callId: String, name: String, image: String?, isVideo: Boolean, startedAtMs: Long
  ): Notification {
    ensureOngoingChannel(this)

    val person = Person.Builder().setName(name).setImportant(true).build()

    // Body tap → (re)launch the app on the active-call screen. action="ongoing"
    // is read back by ExpoCallUiModule.getInitialCallAction()/OnNewIntent and, in
    // JS, restores a minimized call instead of re-ringing.
    val contentIntent = PendingIntent.getActivity(
      this, (callId + "ongoing").hashCode(),
      ExpoCallUiModule.launchIntent(this, "ongoing", callId, null, name, image, if (isVideo) "video" else "audio"),
      ExpoCallUiModule.pendingFlags()
    )
    // Hang up → broadcast to CallActionReceiver (stops the service + signals JS).
    val hangupIntent = PendingIntent.getBroadcast(
      this, (callId + "hangup").hashCode(),
      Intent(this, CallActionReceiver::class.java).apply {
        action = ACTION_HANGUP
        putExtra(EXTRA_CALL_ID, callId)
      },
      ExpoCallUiModule.pendingFlags()
    )

    var smallIcon = resources.getIdentifier("notification_icon", "drawable", packageName)
    if (smallIcon == 0) smallIcon = android.R.drawable.sym_action_call

    val builder = NotificationCompat.Builder(this, ONGOING_CHANNEL_ID)
      .setSmallIcon(smallIcon)
      .setContentTitle(name)
      .setContentText(if (isVideo) "Ongoing video call" else "Ongoing voice call")
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .setContentIntent(contentIntent)
      .setStyle(
        NotificationCompat.CallStyle.forOngoingCall(person, hangupIntent)
          .setIsVideo(isVideo)
      )

    // Live duration chronometer. setWhen to the answer time + usesChronometer
    // makes the system render a counting-up timer; CallStyle surfaces it as the
    // call duration. ALWAYS set (fall back to "now" when the answer time is
    // unknown) so the status-bar/shade notification shows a running timer.
    val whenBase = if (startedAtMs > 0) startedAtMs else System.currentTimeMillis()
    builder.setWhen(whenBase).setUsesChronometer(true).setShowWhen(true)

    if (!image.isNullOrBlank()) {
      // Avatar is best-effort: a remote URL can't be loaded synchronously here,
      // so we skip it rather than block the FGS start. (The in-app call screen
      // already shows the avatar; the notification stays text + CallStyle icon.)
    }

    return builder.build()
  }

  // Returns true if the service was promoted to the foreground. NEVER posts a
  // bare notification as a "fallback" — a started service that never calls
  // startForeground() is killed by the OS watchdog (and takes the app + live call
  // down with it), so on failure we report false and the caller stops the service.
  private fun startForegroundWithType(notification: Notification, isVideo: Boolean): Boolean {
    // Try the typed foreground service first.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (isVideo) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        startForeground(ONGOING_NOTIF_ID, notification, type)
      } else {
        startForeground(ONGOING_NOTIF_ID, notification)
      }
      return true
    } catch (_: Exception) {
      // e.g. ForegroundServiceStartNotAllowedException (started while the app was
      // in the background) or a missing FGS-type permission. Try once more without
      // an explicit type before giving up.
    }
    return try {
      startForeground(ONGOING_NOTIF_ID, notification)
      true
    } catch (_: Exception) {
      false
    }
  }

  private fun stopForegroundCompat() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (_: Exception) { /* */ }
    // Also cancel directly in case the notification was posted via the non-FGS
    // fallback path (NotificationManagerCompat), which stopForeground won't clear.
    try { NotificationManagerCompat.from(this).cancel(ONGOING_NOTIF_ID) } catch (_: Exception) { /* */ }
  }

  override fun onDestroy() {
    // Belt-and-braces: ensure the ongoing notification is gone when the service
    // is torn down via stopService() (no ACTION_STOP round-trip).
    try { NotificationManagerCompat.from(this).cancel(ONGOING_NOTIF_ID) } catch (_: Exception) { /* */ }
    super.onDestroy()
  }

  companion object {
    const val ACTION_STOP = "expo.modules.callui.STOP_ONGOING"
    const val ONGOING_CHANNEL_ID = "calls_ongoing"
    const val ONGOING_NOTIF_ID = 424242

    fun ensureOngoingChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(ONGOING_CHANNEL_ID) != null) return
      // IMPORTANCE_LOW: silent, no heads-up — this is a persistent status, not an
      // alert (the incoming ring uses its own HIGH-importance channel).
      val channel = NotificationChannel(
        ONGOING_CHANNEL_ID, "Ongoing Calls", NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Persistent notification shown during an active call"
        setShowBadge(false)
        enableVibration(false)
        setSound(null, null)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      }
      nm.createNotificationChannel(channel)
    }

    fun start(
      ctx: Context, callId: String, name: String?, image: String?, type: String?, startedAtMs: Long
    ) {
      val i = Intent(ctx, CallForegroundService::class.java).apply {
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_CALLER_NAME, name)
        putExtra(EXTRA_CALLER_IMAGE, image)
        putExtra(EXTRA_CALL_TYPE, type ?: "audio")
        putExtra(EXTRA_STARTED_AT, startedAtMs)
      }
      try { ContextCompat.startForegroundService(ctx, i) } catch (_: Exception) { /* */ }
    }

    fun stop(ctx: Context) {
      try { ctx.stopService(Intent(ctx, CallForegroundService::class.java)) } catch (_: Exception) { /* */ }
    }

    // Map the answer time to an elapsed-realtime base if ever needed by callers.
    @Suppress("unused")
    fun elapsedBaseFor(startedAtMs: Long): Long =
      SystemClock.elapsedRealtime() - (System.currentTimeMillis() - startedAtMs)
  }
}
