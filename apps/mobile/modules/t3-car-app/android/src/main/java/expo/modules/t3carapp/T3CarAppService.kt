package expo.modules.t3carapp

import android.content.Intent
import androidx.car.app.CarAppService
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Template
import androidx.car.app.validation.HostValidator

/** Puts T3 Code in the Android Auto launcher. The screen is a placeholder until phase 2. */
class T3CarAppService : CarAppService() {
  // Only Android Auto and the Desktop Head Unit may bind; screens will carry thread titles.
  override fun createHostValidator() =
    HostValidator.Builder(applicationContext)
      .addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample)
      .build()

  override fun onCreateSession() =
    object : Session() {
      override fun onCreateScreen(intent: Intent): Screen = PlaceholderScreen(carContext)
    }
}

private class PlaceholderScreen(carContext: CarContext) : Screen(carContext) {
  override fun onGetTemplate(): Template =
    ListTemplate.Builder()
      .setTitle("T3 Code")
      .setHeaderAction(Action.APP_ICON)
      .setSingleList(
        ItemList.Builder()
          .setNoItemsMessage("Threads that need you are read out as messages.")
          .build()
      )
      .build()
}
