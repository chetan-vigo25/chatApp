package expo.modules.callui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Handles the Decline tap from the CallStyle notification. Runs in the app
 * process even when JS is killed: dismiss the notification, stop the ring, and
 * signal 'decline'. Answer is NOT handled here: it's a getActivity PendingIntent
 * that launches the app directly (a receiver startActivity would be blocked by
 * Android 10+ background-activity-start limits), handled by ExpoCallUiModule's
 * intent reading.
 *
 * P-C-06: when JS is NOT observing (killed / still booting) the Decline used to be
 * parked only in memory and never reached the server, so the caller rang the full
 * ~40 s. It is now PERSISTED (SharedPreferences) and the JS side
 * (CallProvider -> getPendingDeclines) sends the reject as soon as it is
 * authenticated; stale entries are discarded by age. A native HTTPS reject is NOT
 * done here: the access token lives in expo-secure-store (Android Keystore
 * encrypted) and is not readable from native code without new storage.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
    when (intent.action) {
      ACTION_DECLINE -> {
        val callerId = intent.getStringExtra(EXTRA_CALLER_ID)
        NotificationManagerCompat.from(context).cancel(callId.hashCode())
        // Stop the ring (the ring FGS keeps sounding otherwise) and remember the
        // call as cancelled so a late JS/FCM render cannot re-ring it.
        ExpoCallUiModule.cancelIncoming(context, callId)
        if (CallUiBus.isObserving()) {
          CallUiBus.dispatch(
            mapOf(
              "action" to "decline",
              "callId" to callId,
              "callerId" to callerId
            )
          )
        } else {
          // JS cannot see this: persist it so the reject is sent on next start.
          ExpoCallUiModule.persistPendingDecline(context, callId, callerId)
        }
      }
      // Hang up from the active-call ongoing notification: stop the foreground
      // service immediately (so the OS tears down the persistent notification even
      // if JS is slow/killed) and signal 'hangup' into the call flow.
      ACTION_HANGUP -> {
        CallForegroundService.stop(context)
        CallUiBus.dispatch(mapOf("action" to "hangup", "callId" to callId))
      }
    }
  }
}
