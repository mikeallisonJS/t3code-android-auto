package expo.modules.t3carapp

import org.junit.Assert.assertEquals
import org.junit.Test

class CarKeepAliveTest {
  private val calls = mutableListOf<String>()
  private var startAllowed = true
  private val keepAlive =
    CarKeepAlive(
      start = {
        calls += if (startAllowed) "start" else "start refused"
        startAllowed
      },
      stop = { calls += "stop" }
    )

  @Test
  fun runsOnlyWhileTheCarIsConnected() {
    keepAlive.onCarConnectionChanged(true)
    keepAlive.onAppForegrounded()
    keepAlive.onCarConnectionChanged(true)
    keepAlive.onCarConnectionChanged(false)
    keepAlive.onCarConnectionChanged(false)

    assertEquals(listOf("start", "stop"), calls)
  }

  @Test
  fun retriesARefusedStartWhenTheAppReturnsToTheForeground() {
    startAllowed = false
    keepAlive.onCarConnectionChanged(true)
    startAllowed = true
    keepAlive.onAppForegrounded()

    assertEquals(listOf("start refused", "start"), calls)
  }

  @Test
  fun doesNotStartOnForegroundAfterTheCarDisconnectedDuringARefusedStart() {
    startAllowed = false
    keepAlive.onCarConnectionChanged(true)
    keepAlive.onCarConnectionChanged(false)
    startAllowed = true
    keepAlive.onAppForegrounded()

    assertEquals(listOf("start refused"), calls)
  }
}
