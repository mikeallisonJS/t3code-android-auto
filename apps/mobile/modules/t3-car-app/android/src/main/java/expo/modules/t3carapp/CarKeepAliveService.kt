package expo.modules.t3carapp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps the app's connections live while Android Auto is connected.
 *
 * Being a foreground service stops Android from freezing the process once the
 * screen is off. Running a headless JS task matters just as much: React Native
 * stops firing JS timers for a backgrounded app unless one is active, which
 * would stall reconnects and heartbeats on an otherwise healthy socket.
 */
class CarKeepAliveService : HeadlessJsTaskService() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(), serviceType())
    super.onStartCommand(intent, flags, startId)
    // Not sticky: after process death there is no JS runtime holding connections to keep alive.
    return START_NOT_STICKY
  }

  override fun getTaskConfig(intent: Intent?) =
    HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true)

  private fun serviceType() =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
    } else {
      0
    }

  private fun notification(): Notification {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      getSystemService(NotificationManager::class.java).createNotificationChannel(
        NotificationChannel(CHANNEL, "Android Auto", NotificationManager.IMPORTANCE_LOW)
      )
    }
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    return NotificationCompat.Builder(this, CHANNEL)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_info)
      .setContentTitle("Connected to Android Auto")
      .setContentText("Keeping your threads live while you drive.")
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(
        launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE) }
      )
      .build()
  }

  companion object {
    /** Name of the headless task the JS side registers. */
    const val TASK_NAME = "T3CarKeepAlive"
    private const val TAG = "T3CarKeepAlive"
    private const val CHANNEL = "car-connection"
    private const val NOTIFICATION_ID = 0x7c3a

    /** Returns false when Android refuses the start, which it does for a backgrounded app. */
    fun start(context: Context): Boolean =
      try {
        ContextCompat.startForegroundService(context, intent(context))
        true
      } catch (error: IllegalStateException) {
        Log.i(TAG, "Start refused; will retry when the app is next in the foreground", error)
        false
      }

    fun stop(context: Context) {
      context.stopService(intent(context))
    }

    private fun intent(context: Context) = Intent(context, CarKeepAliveService::class.java)
  }
}
