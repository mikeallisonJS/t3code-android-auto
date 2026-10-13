# Android Auto for T3 Code — fork plan

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Goal: monitor and drive remote T3 Code environments hands-free from the car, with the ability to pick which environment a session runs on.

As of 2026-10-09. Upstream's `AGENTS.md` asks that plans live in issues, not the repo; this fork keeps one plan file here on purpose because the car work is a long-lived, fork-only effort. Drop this folder if any of it is ever upstreamed.

## What the car must do

- **Monitor and nudge** running agent threads: hear agent events read aloud, reply by voice (approve, deny, answer a question, redirect).
- **Start and steer** new work: pick the environment, dictate a task, follow progress.

Android Auto only admits a few app categories (messaging, media, navigation, POI). The design fits inside those: a messaging-style surface for live threads plus a Car App Library list screen for environment selection. Transcript and diff views stay phone-only.

## What's already in the repo

| Area                                         | What's there                                                                                                                                                        | Why it matters                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                                | WebSocket backend all clients talk to                                                                                                                               | Car app is just another client; no CLI wrapping                                                                                    |
| `apps/mobile`                                | Expo RN app; `app.config.ts` has dev/preview/production variants, `eas.json` has `preview:dev` with an Android APK build                                            | Fork target; config plugins under `plugins/` are the right place for manifest/Gradle changes                                       |
| `apps/mobile/modules/t3-agent-notifications` | Native Expo module; `AgentMessagingService` extends `ExpoFirebaseMessagingService`, `postAlert()` builds a `NotificationCompat` with `BigTextStyle`                 | Upstream's notifications arrive via **FCM push**, not the socket. Car messages do not touch this module; they live in `t3-car-app` |
| `apps/mobile/src/connection/`                | Connection supervision and wakeups. Nothing closes the socket on background; Android freezes the process and React Native stops JS timers                           | The car layer keeps both running with a foreground service that runs a headless JS task. `BackgroundScope`s are not involved       |
| `packages/contracts`                         | `WS_METHODS`, `ORCHESTRATION_V2_WS_METHODS.dispatchCommand`, `OrchestrationV2Command`, provider events in `providerRuntime.ts`, `EnvironmentId` in `environment.ts` | The bridge's vocabulary                                                                                                            |
| `packages/client-runtime`                    | Client logic shared by web and mobile, incl. RPC                                                                                                                    | Reuse, don't reimplement                                                                                                           |

## Protocol surface the car needs

Model: environment → thread (a session) → turn (one agent run) → items. Every state change is a typed event; all commands go through `orchestration.dispatchCommand`.

| Car feature             | Events (`providerRuntime.ts`)                                                      | Command                                      |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| Thread list + status    | `thread.started`, `thread.state.changed`, `thread.metadata.updated`                | none                                         |
| Read agent output aloud | `item.started` / item updates, `turn.proposed.completed`, `session.state.changed`  | none                                         |
| Approve / deny          | a thread's `pendingRuntimeRequest` of any kind but `user_input` and `auth_refresh` | `runtime-request.respond` with a decision    |
| Answer a question       | a `pendingRuntimeRequest` of kind `user_input`                                     | `runtime-request.respond` with answers       |
| Steer                   | a running or finished turn                                                         | `message.dispatch` or `run.interrupt`        |
| New thread              | `thread.started` to confirm                                                        | `dispatchCommand` create thread + start turn |

Exact payload shapes: copy from `packages/contracts/src/orchestrationV2.ts` when writing the bridge; do not retype here.

## Architecture

1. **T3 Code servers** — unchanged upstream code, reached over Tailscale, LAN, or T3 Connect.
2. **Phone app** (`apps/mobile`) — owns environments, pairing credentials, thread state. `src/features/car` watches every environment's thread list while the car is connected, decides what to announce, and sends replies through the same commands the thread screen uses. The native side only shows notifications and reports what the driver said.
3. **Car layer** — new Expo module `t3-car-app`, kept separate from upstream's modules so rebases stay clean:
   - _Messaging path_: `MessagingStyle` notifications with reply and mark-as-read semantic actions, one conversation per thread. `CarExtender` is the legacy route and is not used. Android Auto surfaces only the reply and mark-as-read actions, so an approval is given by voice ("approve" or "deny") through the reply action.
   - _What is spoken_: the thread list says only that a thread is waiting, so the question, the approval prompt and the final assistant message are read from thread detail, loaded for that thread only when there is something to announce.
   - _Car App Library service_: `CarAppService` with a `ListTemplate` for environments, a `ListTemplate` for threads in the chosen environment, and a voice-input action to dictate a new task.
   - _Foreground service_: runs while Android Auto is connected so events keep flowing over the socket. It keeps the process unfrozen and, by running a headless JS task, keeps React Native's JS timers firing. A `BackgroundScope` would not help here: it is a lease that tells the server which status polling still has demand, and thread events do not depend on it.

Data flow: server event → socket (held by foreground service) → store → bridge → notification / template refresh. Voice reply → `RemoteInput` → bridge → store → `dispatchCommand`. Nothing on the car side holds credentials.

### Why not rely on FCM for car events

Upstream's agent notifications are FCM push through pingdotgg's Firebase project. A fork can't use that project. Two options:

- **A. Own Firebase project** — new `google-services.json`, and the server's push sender must be pointed at it. Only worth it if phone notifications are also wanted in the fork.
- **B. Socket-driven (recommended for phase 1)** — the foreground service already has to hold the socket for the car to be useful; post car notifications from socket events and ignore FCM entirely in the fork. Strip or stub `AgentMessagingService` so the build doesn't require Firebase.

## Phases

| Phase                 | Work                                                                                                                                                                                                                                                         | Exit                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 0 — Fork and build    | Own EAS `projectId` + `owner` in `app.config.ts`; own Android package (`com.mikeallisonjs.t3code` or keep the `.dev` suffix); keystore; decide FCM option A/B; strip Clerk or keep manual pairing only; `eas build --profile preview:dev --platform android` | Stock app from the fork runs on the phone and pairs one environment over Tailscale |
| 1 — Car notifications | Foreground service keeping the app live in the car; `MessagingStyle` + `RemoteInput` in `t3-car-app`, whose own manifest marks the app as a messaging app and ships `automotive_app_desc.xml`; replies wired to the thread commands                          | Agent question read aloud in the DHU; spoken reply reaches the server              |
| 2 — Car App Library   | `t3-car-app` module with `CarAppService`, environment list, thread list, "New task" voice action; `androidx.car.app` dep via config plugin                                                                                                                   | Pick an environment and start a thread from the DHU                                |
| 3 — Polish + real car | Approve/deny quick actions, status icons, reconnect handling when the tunnel drops, test in the car                                                                                                                                                          | Full drive with monitor + new-thread flows working                                 |
| 4 — Optional          | Upstream the notification work if clean; CarPlay investigation                                                                                                                                                                                               | —                                                                                  |

## Dev environment

- Node + `vp` per root `package.json` engines; `vp i` installs.
- Android Studio with Android SDK, `androidx.car.app`, and the Desktop Head Unit (DHU) emulator.
- Expo + EAS CLI logged into the fork owner's Expo account.
- Physical Android phone with Developer mode; Android Auto developer settings with "Unknown sources" enabled (sideloaded builds don't show on the car screen otherwise).
- At least one remote T3 Code server reachable from the phone (Tailscale or LAN) with a pairing code; a second one to prove environment switching.

## Testing and distribution

- Android, at the desk: `eas build --profile preview:dev --platform android` → internal APK → DHU emulator. `preview:dev` is a development client: the APK carries no JS and loads it from Metro on the dev machine.
- Android, in the car: the standalone `preview` profile, which bundles the JS. A `preview:dev` build cannot run away from the dev machine.
- The app is built from upstream `main` and only connects to servers on the same orchestration protocol. A released T3 Code that is behind `main` on protocol is refused with "This client requires a newer server". Until the servers you drive are on a matching release, test against the fork's own dev server (`vp run dev --share`, always with an explicit `--home-dir` so it cannot land on the live `~/.t3`).
- iOS: TestFlight works for the phone app, but there is no Android Auto equivalent; CarPlay is a separate effort.

## Open questions

- [x] FCM: option B, socket-only. The app builds with no `google-services.json` and treats a failed push-token lookup as notifications off, so nothing is stripped.
- [x] Clerk / T3 Connect: nothing to strip. Every Clerk surface is gated on `hasCloudPublicConfig()`, so a build with no Clerk keys only offers manual pairing.
- [x] Android package: `com.mikeallisonjs.t3code` (production) and `com.mikeallisonjs.t3code.preview` (preview). The development variant keeps upstream's `com.t3tools.t3code.dev` because `scripts/mobile-native-client.ts` and the `test-t3-mobile` skill hardcode it.
- [ ] Keeping the fork rebased on a fast-moving upstream: keep all car code in its own module and config plugins to limit conflicts.
