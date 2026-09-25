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

  // The FGS type this instance is CURRENTLY promoted as, or 0 when not foreground.
  // Needed because Android 14+ refuses to convert a SHORT_SERVICE into any other
  // type by calling startForeground() again — see demoteShortServiceIfNeeded().
  private var currentFgsType: Int = 0

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopForegroundCompat()
      stopSelf()
      return START_NOT_STICKY
    }

    val callId = intent?.getStringExtra(EXTRA_CALL_ID)
    if (callId.isNullOrBlank()) {
      startHandled()
      stopSelf(startId)
      return START_NOT_STICKY
    }
    val name = intent.getStringExtra(EXTRA_CALLER_NAME)?.takeIf { it.isNotBlank() } ?: "Ongoing call"
    val image = intent.getStringExtra(EXTRA_CALLER_IMAGE)
    val type = intent.getStringExtra(EXTRA_CALL_TYPE) ?: "audio"
    val isVideo = type == "video"
    // Wall-clock ms when the call was answered; 0 → count from now.
    val startedAtMs = intent.getLongExtra(EXTRA_STARTED_AT, 0L)
    // "ringing" = outgoing call still dialing (no answer yet) → "Calling…", no
    // timer. "connecting" = answered but media not up yet → "Connecting…", no
    // timer (a counting-up duration here contradicted the in-app "Connecting…"
    // screen). "ongoing" = media connected → live duration chronometer.
    val state = intent.getStringExtra(EXTRA_STATE) ?: "ongoing"

    // RINGING (incoming): the CallStyle banner the module already posted is handed
    // to this service so the SERVICE owns it. Without that, Android drops the
    // ring notification the moment the app leaves the foreground — the user
    // pressed Home over the lock screen and the call rang on with nothing in the
    // tray to answer from (it then landed as "Missed"). Same notification, same
    // id: taking ownership never shows a second one.
    val incoming = state == "incoming"
    val notification = if (incoming) {
      ExpoCallUiModule.buildIncomingNotification(
        this, callId, intent.getStringExtra(EXTRA_CALLER_ID), name, image, type,
        intent.getBooleanExtra(EXTRA_FULL_SCREEN, true)
      )
    } else {
      buildNotification(callId, name, image, isVideo, startedAtMs, state)
    }
    val notifId = if (incoming) callId.hashCode() else ONGOING_NOTIF_ID
    val promoted = if (incoming) startForegroundForRing(notification, notifId)
      else startForegroundWithType(notification, isVideo, notifId)
    // startForeground() has now run for this start — a stop() that arrived while
    // it was queued can be honoured safely (see deferredStopPending).
    if (startHandled()) {
      android.util.Log.i(TAG, "applying stop() that arrived while this start was pending")
      stopForegroundCompat()
      // stopSelf(startId), NOT stopSelf(): during a ring re-post burst another
      // startForegroundService() can already be queued behind this one. A plain
      // stopSelf() destroyed the service under it → that start never reached
      // startForeground → ForegroundServiceDidNotStartInTimeException, app killed
      // mid-ring (2026-09-24). With the id, a newer start keeps the service alive
      // and promotes it itself.
      stopSelf(startId)
      return START_NOT_STICKY
    }
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
    callId: String, name: String, image: String?, isVideo: Boolean, startedAtMs: Long,
    state: String = "ongoing"
  ): Notification {
    val ringing = state == "ringing"
    val connecting = state == "connecting"
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

    val contentText = when {
      ringing && isVideo -> "Calling… (video)"
      ringing -> "Calling…"
      connecting -> "Connecting…"
      isVideo -> "Ongoing video call"
      else -> "Ongoing voice call"
    }

    val builder = NotificationCompat.Builder(this, ONGOING_CHANNEL_ID)
      .setSmallIcon(smallIcon)
      .setContentTitle(name)
      .setContentText(contentText)
      .setCategory(NotificationCompat.CATEGORY_CALL)
      .setOngoing(true)
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .setContentIntent(contentIntent)
      .setStyle(
        NotificationCompat.CallStyle.forOngoingCall(person, hangupIntent)
          .setIsVideo(isVideo)
      )

    if (ringing || connecting || startedAtMs <= 0L) {
      // No duration timer while dialing OR while the answered call's media is
      // still connecting — a counting-up "0:27" next to the in-app
      // "Connecting…" screen reads as a connected call that has no audio.
      // startedAtMs<=0 is the same signal from an older JS bundle (connectedAt
      // not stamped yet), so it never falls back to a fake "now" timer.
      builder.setShowWhen(false).setUsesChronometer(false)
    } else {
      // Live duration chronometer from the media-connect time (connectedAt) —
      // matches the in-app timer exactly.
      builder.setWhen(startedAtMs).setUsesChronometer(true).setShowWhen(true)
    }

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
  // The RING service. phoneCall type, never microphone: this one is routinely
  // started while the app sits in the background (the push arrives with the
  // screen off), and Android refuses mic/camera access to a background-started
  // FGS — the service was then torn down and the ring notification went with it.
  private fun startForegroundForRing(notification: Notification, notifId: Int): Boolean {
    // shortService (Android 14+) is the one type a BACKGROUND start may use with
    // no special role: phoneCall needs the app to be the default dialer / a
    // self-managed ConnectionService (it was refused here and the service died
    // silently), and mic/camera are stripped from a background-started service.
    // Its ~3 minute budget is far longer than a 40s ring, and answering swaps it
    // for the ongoing microphone service from the foreground, where that is allowed.
    val types = if (Build.VERSION.SDK_INT >= 34) {
      intArrayOf(
        ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE,
        ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL,
      )
    } else {
      intArrayOf(ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL)
    }
    for (type in types) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
          startForeground(notifId, notification, type)
        } else {
          startForeground(notifId, notification)
        }
        currentFgsType = type
        android.util.Log.i(TAG, "ring FGS started (type=$type)")
        return true
      } catch (e: Exception) {
        android.util.Log.w(TAG, "ring FGS type=$type refused: ${e.message}")
      }
    }
    return try {
      startForeground(notifId, notification)
      currentFgsType = 0
      android.util.Log.i(TAG, "ring FGS started (legacy, no type)")
      true
    } catch (e: Exception) {
      android.util.Log.w(TAG, "ring FGS failed: ${e.message}")
      false
    }
  }

  /**
   * Android 14+ will NOT convert a SHORT_SERVICE foreground service into another
   * type: calling startForeground() again with FOREGROUND_SERVICE_TYPE_MICROPHONE
   * throws, and the service quietly stays a shortService.
   *
   * That is exactly what happened to every answered call. The ring is promoted as
   * SHORT_SERVICE (the only type a BACKGROUND start may use — see
   * startForegroundForRing), and when the user answered, the ongoing service ran
   * on the SAME instance and could never claim the microphone. Measured on device
   * during a live, connected call:
   *
   *     isForeground=true  types=0x00000800   ← 0x800 = SHORT_SERVICE
   *     W/ActivityManager: Foreground service started from background
   *                        can not have location/camera/microphone access
   *
   * Android refuses mic/camera to that service for its whole life, so the call
   * connected and ran silent — the "awaaz nahi aati" report. (SHORT_SERVICE also
   * carries a ~3 minute budget, so a longer call would be stopped outright.)
   *
   * Dropping the foreground promotion first lets the very next startForeground()
   * be a FRESH one, which may claim microphone/camera — the app is TOP at that
   * moment, because answering is a user action, so the OS allows it.
   */
  private fun demoteShortServiceIfNeeded() {
    if (Build.VERSION.SDK_INT < 34) return
    if (currentFgsType != ServiceInfo.FOREGROUND_SERVICE_TYPE_SHORT_SERVICE) return
    try {
      stopForeground(STOP_FOREGROUND_REMOVE)
      currentFgsType = 0
      android.util.Log.i(TAG, "dropped shortService promotion before claiming microphone")
    } catch (e: Exception) {
      android.util.Log.w(TAG, "could not drop shortService promotion: ${e.message}")
    }
  }

  private fun startForegroundWithType(
    notification: Notification, isVideo: Boolean, notifId: Int = ONGOING_NOTIF_ID
  ): Boolean {
    demoteShortServiceIfNeeded()
    // Try the typed foreground service first.
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        if (isVideo) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
        startForeground(notifId, notification, type)
        currentFgsType = type
        android.util.Log.i(TAG, "ongoing FGS started (type=$type)")
      } else {
        startForeground(notifId, notification)
        currentFgsType = 0
      }
      return true
    } catch (e: Exception) {
      android.util.Log.w(TAG, "ongoing FGS microphone type refused: ${e.message}")
      // e.g. ForegroundServiceStartNotAllowedException (started while the app was
      // in the background) or a missing FGS-type permission. Try once more without
      // an explicit type before giving up.
    }
    return try {
      startForeground(notifId, notification)
      currentFgsType = 0
      android.util.Log.i(TAG, "ongoing FGS started (legacy, no type)")
      true
    } catch (e: Exception) {
      android.util.Log.w(TAG, "ongoing FGS failed: ${e.message}")
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

  // ── App swiped away from Recents during an ACTIVE call ──
  // The call KEEPS RUNNING. Removing the task destroys the Activity, and React
  // Native responds by unloading its surface — so the whole React tree unmounts
  // — but neither touches the process. This foreground service is what keeps the
  // process alive, and everything the call actually runs on lives in module
  // singletons that have no UI to unmount with: the native WebRTC engine and its
  // mediasoup transports, the signaling sockets, and the mic/camera capture this
  // service's foreground types cover. The user keeps full control from this
  // notification — body tap re-opens the call screen, Hang up ends the call.
  //
  // (This deliberately no longer hangs up. It used to, because the call's media
  // ran inside a WebView that died with the task; the engine has since moved to
  // native react-native-webrtc — see engineSelector.js — so the media survives.)
  //
  // Two things make that survival real, and neither is here:
  //   • android:stopWithTask="false" in the manifest, or the OS destroys this
  //     service right after this callback and takes the process with it;
  //   • callSessionKeeper.js on the JS side, which owns the engine subscription
  //     across the unmount so a call that ENDS while no UI is mounted still
  //     releases the mic and clears this notification, and so a re-opened app
  //     re-adopts the running call instead of booting into an empty idle state.
  override fun onTaskRemoved(rootIntent: Intent?) {
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    // Belt-and-braces: ensure the ongoing notification is gone when the service
    // is torn down via stopService() (no ACTION_STOP round-trip).
    try { NotificationManagerCompat.from(this).cancel(ONGOING_NOTIF_ID) } catch (_: Exception) { /* */ }
    super.onDestroy()
  }

  companion object {
    const val TAG = "CallFgService"
    const val ACTION_STOP = "expo.modules.callui.STOP_ONGOING"
    const val EXTRA_CALLER_ID = "callerId"
    const val EXTRA_FULL_SCREEN = "fullScreen"
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
      ctx: Context, callId: String, name: String?, image: String?, type: String?, startedAtMs: Long,
      state: String? = "ongoing"
    ) {
      ringingCallId = null
      val i = Intent(ctx, CallForegroundService::class.java).apply {
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_CALLER_NAME, name)
        putExtra(EXTRA_CALLER_IMAGE, image)
        putExtra(EXTRA_CALL_TYPE, type ?: "audio")
        putExtra(EXTRA_STARTED_AT, startedAtMs)
        putExtra(EXTRA_STATE, state ?: "ongoing")
      }
      startRequested(ctx, i)
    }

    // Hand an incoming ring to the service so the OS keeps its notification alive
    // while the app is backgrounded. Best-effort: if the FGS start is refused the
    // service stops itself and the plain notification the module posted stays.
    // callId whose incoming RING the service is holding (null while an ongoing
    // call or nothing runs) — so a cancel for that call can stop the service
    // without touching a different, live call.
    @Volatile var ringingCallId: String? = null

    fun startForIncoming(
      ctx: Context, callId: String, callerId: String?, name: String?, image: String?, type: String?,
      fullScreen: Boolean = true
    ) {
      ringingCallId = callId
      val i = Intent(ctx, CallForegroundService::class.java).apply {
        putExtra(EXTRA_CALL_ID, callId)
        putExtra(EXTRA_CALLER_ID, callerId)
        putExtra(EXTRA_CALLER_NAME, name)
        putExtra(EXTRA_CALLER_IMAGE, image)
        putExtra(EXTRA_CALL_TYPE, type ?: "audio")
        putExtra(EXTRA_STATE, "incoming")
        putExtra(EXTRA_FULL_SCREEN, fullScreen)
      }
      startRequested(ctx, i)
    }

    // ---- start/stop race guard ----
    // startForegroundService() obliges the service to call startForeground() once
    // its onStartCommand runs. Stopping it BEFORE that (stopService while the start
    // is still queued) is fatal on Android 12+: "Bringing down service while still
    // waiting for start foreground" → ForegroundServiceDidNotStartInTimeException,
    // and the whole app — call included — is killed. That is exactly the accept
    // path on a busy main thread: the tap starts the ongoing (mic) service, and
    // ~250ms later the ring cancel stops the same service before onStartCommand
    // ran (reproduced 2026-09-23 on a cold-started, just-woken app).
    // So a stop() that lands while a start is pending is DEFERRED: the service
    // promotes itself first, then stops. A start() issued after the stop()
    // cancels the deferred stop — the latest request wins, as before.
    private val pendingStarts = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile private var deferredStopPending = false

    private fun startRequested(ctx: Context, i: Intent) {
      deferredStopPending = false
      pendingStarts.incrementAndGet()
      try {
        ContextCompat.startForegroundService(ctx, i)
      } catch (_: Exception) {
        // Never delivered — don't let it block future stops.
        pendingStarts.decrementAndGet()
      }
    }

    /** Called once per delivered start; true when a deferred stop should run now. */
    private fun startHandled(): Boolean {
      val left = pendingStarts.decrementAndGet()
      if (left < 0) pendingStarts.set(0)
      if (left <= 0 && deferredStopPending) {
        deferredStopPending = false
        return true
      }
      return false
    }

    fun stop(ctx: Context) {
      ringingCallId = null
      if (pendingStarts.get() > 0) {
        android.util.Log.i(TAG, "stop() while a start is pending — deferring until startForeground ran")
        deferredStopPending = true
        return
      }
      try { ctx.stopService(Intent(ctx, CallForegroundService::class.java)) } catch (_: Exception) { /* */ }
    }

    // Map the answer time to an elapsed-realtime base if ever needed by callers.
    @Suppress("unused")
    fun elapsedBaseFor(startedAtMs: Long): Long =
      SystemClock.elapsedRealtime() - (System.currentTimeMillis() - startedAtMs)
  }
}
