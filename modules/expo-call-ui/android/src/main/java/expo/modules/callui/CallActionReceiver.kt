package expo.modules.callui

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat

/**
 * Handles the Decline tap from the CallStyle notification. Runs in the app
 * process even when JS is killed: dismiss the notification and signal 'decline'
 * (best-effort — if the app is fully killed the caller's ring timeout ends the
 * call). Answer is NOT handled here: it's a getActivity PendingIntent that
 * launches the app directly (a receiver startActivity would be blocked by
 * Android 10+ background-activity-start limits), handled by ExpoCallUiModule's
 * intent reading.
 */
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != ACTION_DECLINE) return
    val callId = intent.getStringExtra(EXTRA_CALL_ID) ?: return
    NotificationManagerCompat.from(context).cancel(callId.hashCode())
    CallUiBus.dispatch(
      mapOf(
        "action" to "decline",
        "callId" to callId,
        "callerId" to intent.getStringExtra(EXTRA_CALLER_ID)
      )
    )
  }
}
