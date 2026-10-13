package expo.modules.t3carapp

/**
 * Decides when the keep-alive service runs: for as long as Android Auto is
 * connected. Android refuses to start a foreground service while the app is in
 * the background, so [start] reports whether it succeeded and a refused start
 * is retried the next time the app comes to the foreground.
 */
internal class CarKeepAlive(
  private val start: () -> Boolean,
  private val stop: () -> Unit
) {
  private var connected = false
  private var running = false

  fun onCarConnectionChanged(isConnected: Boolean) {
    connected = isConnected
    sync()
  }

  fun onAppForegrounded() = sync()

  private fun sync() {
    if (connected && !running) {
      running = start()
    } else if (!connected && running) {
      running = false
      stop()
    }
  }
}
