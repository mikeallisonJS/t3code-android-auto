import { AppRegistry } from "react-native";

import { carApp } from "./carModule";

/**
 * Registers the task the native keep-alive service runs while Android Auto is
 * connected. React Native stops firing JS timers for a backgrounded Android app
 * unless a headless task is active, so the task simply stays pending until the
 * car disconnects. Call once at startup, before the root component registers.
 */
export function registerCarKeepAliveTask(): void {
  const native = carApp;
  if (native === null) return;
  AppRegistry.registerHeadlessTask(
    "T3CarKeepAlive",
    () => () =>
      new Promise<void>((resolve) => {
        const subscription = native.addListener("onCarConnectionChange", (event) => {
          if (event.connected) return;
          subscription.remove();
          resolve();
        });
        // The car may have disconnected before this listener was attached.
        if (!native.isCarConnected()) {
          subscription.remove();
          resolve();
        }
      }),
  );
}
