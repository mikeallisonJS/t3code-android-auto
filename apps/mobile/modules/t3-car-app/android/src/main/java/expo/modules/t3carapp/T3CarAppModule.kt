package expo.modules.t3carapp

import android.os.Handler
import android.os.Looper
import androidx.car.app.connection.CarConnection
import androidx.lifecycle.LiveData
import androidx.lifecycle.Observer
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3CarAppModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var connectionType: LiveData<Int>? = null
  private var keepAlive: CarKeepAlive? = null

  @Volatile private var connected = false

  private val connectionObserver =
    Observer<Int> { type ->
      // Projection is Android Auto. Native means Android Automotive, where the app runs in the car.
      connected = type == CarConnection.CONNECTION_TYPE_PROJECTION
      keepAlive?.onCarConnectionChanged(connected)
      sendEvent(CONNECTION_EVENT, mapOf("connected" to connected))
    }

  override fun definition() =
    ModuleDefinition {
      Name("T3CarApp")

      Events(CONNECTION_EVENT, REPLY_EVENT)

      Function("isCarConnected") { connected }

      Function("postMessage") {
          key: String,
          sender: String,
          text: String,
          url: String,
          replyMode: String
        ->
        appContext.reactContext?.let { CarMessages.post(it, key, sender, text, url, replyMode) }
      }

      Function("cancelMessage") { key: String ->
        appContext.reactContext?.let { CarMessages.cancel(it, key) }
      }

      Function("cancelAllMessages") {
        appContext.reactContext?.let { CarMessages.cancelAll(it) }
      }

      OnCreate {
        val context = appContext.reactContext?.applicationContext ?: return@OnCreate
        CarMessages.onReply = { key, text ->
          sendEvent(REPLY_EVENT, mapOf("key" to key, "text" to text))
        }
        main.post {
          val state =
            CarKeepAlive(
              start = { CarKeepAliveService.start(context) },
              stop = { CarKeepAliveService.stop(context) }
            )
          keepAlive = state
          connectionType = CarConnection(context).type.also { it.observeForever(connectionObserver) }
        }
      }

      OnActivityEntersForeground { main.post { keepAlive?.onAppForegrounded() } }

      OnDestroy {
        CarMessages.onReply = null
        main.post {
          connectionType?.removeObserver(connectionObserver)
          connectionType = null
          keepAlive?.onCarConnectionChanged(false)
          keepAlive = null
        }
      }
    }

  private companion object {
    const val CONNECTION_EVENT = "onCarConnectionChange"
    const val REPLY_EVENT = "onCarMessageReply"
  }
}
