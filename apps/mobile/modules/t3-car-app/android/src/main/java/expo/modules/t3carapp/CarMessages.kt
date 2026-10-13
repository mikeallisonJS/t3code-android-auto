package expo.modules.t3carapp

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput

class CarMessageReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    CarMessages.handle(context, intent)
  }
}

/**
 * Posts thread events as messaging notifications, the form Android Auto reads
 * aloud and lets the driver answer by voice. Each thread is one conversation,
 * so a newer event replaces the thread's previous one.
 */
internal object CarMessages {
  const val REPLY_NONE = "none"
  const val REPLY_APPROVAL = "approval"

  private const val CHANNEL = "car-messages"
  private const val TAG = "t3-car-message"
  private const val KEY_REPLY = "reply"
  private const val ACTION_REPLY = "expo.modules.t3carapp.REPLY"
  private const val ACTION_READ = "expo.modules.t3carapp.READ"
  private const val ACTION_APPROVE = "expo.modules.t3carapp.APPROVE"
  private const val ACTION_DENY = "expo.modules.t3carapp.DENY"

  /** Receives the thread key and the driver's words. Set while the JS side is listening. */
  @Volatile var onReply: ((key: String, text: String) -> Unit)? = null

  fun post(context: Context, key: String, sender: String, text: String, url: String, replyMode: String) {
    channel(context)
    val agent = Person.Builder().setName(sender).setKey(key).build()
    val style =
      NotificationCompat.MessagingStyle(Person.Builder().setName("You").build())
        .addMessage(text, System.currentTimeMillis(), agent)
    val icon = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    val builder =
      NotificationCompat.Builder(context, CHANNEL)
        .setSmallIcon(if (icon != 0) icon else android.R.drawable.ic_dialog_info)
        .setStyle(style)
        .setCategory(NotificationCompat.CATEGORY_MESSAGE)
        .setPriority(NotificationCompat.PRIORITY_HIGH)
        .setAutoCancel(true)
        .setContentIntent(openThread(context, key, url))
        // Android Auto only shows conversations it can mark as read.
        .addInvisibleAction(
          NotificationCompat.Action.Builder(0, "Mark as read", broadcast(context, ACTION_READ, key))
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
        )
    if (replyMode != REPLY_NONE) {
      builder.addAction(
        NotificationCompat.Action.Builder(0, "Reply", broadcast(context, ACTION_REPLY, key))
          .addRemoteInput(RemoteInput.Builder(KEY_REPLY).setLabel("Reply").build())
          .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
          .setShowsUserInterface(false)
          .build()
      )
    }
    if (replyMode == REPLY_APPROVAL) {
      builder.addAction(0, "Approve", broadcast(context, ACTION_APPROVE, key))
      builder.addAction(0, "Deny", broadcast(context, ACTION_DENY, key))
    }
    manager(context).notify(TAG, key.hashCode(), builder.build())
  }

  fun cancel(context: Context, key: String) {
    manager(context).cancel(TAG, key.hashCode())
  }

  fun cancelAll(context: Context) {
    val manager = manager(context)
    manager.activeNotifications.filter { it.tag == TAG }.forEach { manager.cancel(it.tag, it.id) }
  }

  fun handle(context: Context, intent: Intent) {
    val key = intent.data?.getQueryParameter("key") ?: return
    val text =
      when (intent.action) {
        ACTION_REPLY -> RemoteInput.getResultsFromIntent(intent)?.getCharSequence(KEY_REPLY)?.toString()
        ACTION_APPROVE -> "approve"
        ACTION_DENY -> "deny"
        else -> null
      }
    // Answered or read either way; the JS side posts again if the answer did not land.
    cancel(context, key)
    if (!text.isNullOrBlank()) onReply?.invoke(key, text)
  }

  private fun broadcast(context: Context, action: String, key: String): PendingIntent {
    val intent =
      Intent(context, CarMessageReceiver::class.java)
        .setAction(action)
        // The data URI makes each thread's intents distinct.
        .setData(Uri.Builder().scheme("t3car").authority("message").appendQueryParameter("key", key).build())
    // The system fills in the spoken reply, which needs a mutable intent.
    val mutability =
      if (action == ACTION_REPLY && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_MUTABLE
      } else {
        PendingIntent.FLAG_IMMUTABLE
      }
    return PendingIntent.getBroadcast(
      context,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or mutability
    )
  }

  private fun openThread(context: Context, key: String, url: String): PendingIntent? {
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
    intent.setAction(Intent.ACTION_VIEW).setData(Uri.parse(url))
      .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context,
      key.hashCode(),
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

  private fun channel(context: Context) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager(context).createNotificationChannel(
        NotificationChannel(CHANNEL, "Android Auto messages", NotificationManager.IMPORTANCE_HIGH)
      )
    }
  }
}
