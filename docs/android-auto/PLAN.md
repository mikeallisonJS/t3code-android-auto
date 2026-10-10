# Android Auto for T3 Code — fork plan

Fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code). Goal: monitor and drive remote T3 Code environments hands-free from the car, with the ability to pick which environment a session runs on.

As of 2026-10-09. Upstream's `AGENTS.md` asks that plans live in issues, not the repo; this fork keeps one plan file here on purpose because the car work is a long-lived, fork-only effort. Drop this folder if any of it is ever upstreamed.

## What the car must do

- **Monitor and nudge** running agent threads: hear agent events read aloud, reply by voice (approve, deny, answer a question, redirect).
- **Start and steer** new work: pick the environment, dictate a task, follow progress.

Android Auto only admits a few app categories (messaging, media, navigation, POI). The design fits inside those: a messaging-style surface for live threads plus a Car App Library list screen for environment selection. Transcript and diff views stay phone-only.

## What's already in the repo

| Area                                         | What's there                                                                                                                                                        | Why it matters                                                                                                               |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`                                | WebSocket backend all clients talk to                                                                                                                               | Car app is just another client; no CLI wrapping                                                                              |
| `apps/mobile`                                | Expo RN app; `app.config.ts` has dev/preview/production variants, `eas.json` has `preview:dev` with an Android APK build                                            | Fork target; config plugins under `plugins/` are the right place for manifest/Gradle changes                                 |
| `apps/mobile/modules/t3-agent-notifications` | Native Expo module; `AgentMessagingService` extends `ExpoFirebaseMessagingService`, `postAlert()` builds a `NotificationCompat` with `BigTextStyle`                 | Agent notifications arrive via **FCM push**, not the socket. `postAlert`/`base` is where `MessagingStyle` + `CarExtender` go |
| `apps/mobile/src/connection/`                | `MOBILE_BACKGROUND_RECONNECT_AFTER_MS = 10_000`; ref-counted `BackgroundScope`s per environment                                                                     | The socket is dropped in the background. The car layer must hold a scope from a foreground service                           |
| `packages/contracts`                         | `WS_METHODS`, `ORCHESTRATION_V2_WS_METHODS.dispatchCommand`, `OrchestrationV2Command`, provider events in `providerRuntime.ts`, `EnvironmentId` in `environment.ts` | The bridge's vocabulary                                                                                                      |
| `packages/client-runtime`                    | Client logic shared by web and mobile, incl. RPC                                                                                                                    | Reuse, don't reimplement                                                                                                     |

## Protocol surface the car needs

Model: environment → thread (a session) → turn (one agent run) → items. Every state change is a typed event; all commands go through `orchestration.dispatchCommand`.

| Car feature             | Events (`providerRuntime.ts`)                                                      | Command                                      |
| ----------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------- |
| Thread list + status    | `thread.started`, `thread.state.changed`, `thread.metadata.updated`                | none                                         |
| Read agent output aloud | `item.started` / item updates, `turn.proposed.completed`, `session.state.changed`  | none                                         |
| Approve / deny          | request types `permission_approval`, `mcp_elicitation_approval`, `tool_user_input` | `dispatchCommand` with the approval response |
| Voice reply / steer     | same request types, or a running turn                                              | `dispatchCommand` user message or interrupt  |
| New thread              | `thread.started` to confirm                                                        | `dispatchCommand` create thread + start turn |

Exact payload shapes: copy from `packages/contracts/src/orchestrationV2.ts` when writing the bridge; do not retype here.

## Architecture

1. **T3 Code servers** — unchanged upstream code, reached over Tailscale, LAN, or T3 Connect.
2. **Phone app** (`apps/mobile`) — owns environments, pairing credentials, thread state. A Kotlin bridge exposes the active environment and thread events to the car layer and accepts commands back.
3. **Car layer** — new Expo module `t3-car-app`:
   - _Messaging path_: `MessagingStyle` + `CarExtender` + reply `RemoteInput` on the existing notification channel, one conversation per thread.
   - _Car App Library service_: `CarAppService` with a `ListTemplate` for environments, a `ListTemplate` for threads in the chosen environment, and a voice-input action to dictate a new task.
   - _Foreground service_: holds a `BackgroundScope` on the selected environment while Android Auto is connected so events keep flowing over the socket.

Data flow: server event → socket (held by foreground service) → store → bridge → notification / template refresh. Voice reply → `RemoteInput` → bridge → store → `dispatchCommand`. Nothing on the car side holds credentials.

### Why not rely on FCM for car events

Upstream's agent notifications are FCM push through pingdotgg's Firebase project. A fork can't use that project. Two options:

- **A. Own Firebase project** — new `google-services.json`, and the server's push sender must be pointed at it. Only worth it if phone notifications are also wanted in the fork.
- **B. Socket-driven (recommended for phase 1)** — the foreground service already has to hold the socket for the car to be useful; post car notifications from socket events and ignore FCM entirely in the fork. Strip or stub `AgentMessagingService` so the build doesn't require Firebase.

## Phases

| Phase                 | Work                                                                                                                                                                                                                                                           | Exit                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 0 — Fork and build    | Own EAS `projectId` + `owner` in `app.config.ts`; own Android package (`com.mikeallisonjs.t3code` or keep the `.dev` suffix); keystore; decide FCM option A/B; strip Clerk or keep manual pairing only; `eas build --profile preview:dev --platform android`   | Stock app from the fork runs on the phone and pairs one environment over Tailscale |
| 1 — Car notifications | Foreground service holding a `BackgroundScope`; `MessagingStyle` + `CarExtender` + `RemoteInput` in `t3-agent-notifications` (or a new module); config plugin marking the app as a messaging app + `automotive_app_desc.xml`; reply wired to `dispatchCommand` | Agent question read aloud in the DHU; spoken reply reaches the server              |
| 2 — Car App Library   | `t3-car-app` module with `CarAppService`, environment list, thread list, "New task" voice action; `androidx.car.app` dep via config plugin                                                                                                                     | Pick an environment and start a thread from the DHU                                |
| 3 — Polish + real car | Approve/deny quick actions, status icons, reconnect handling when the tunnel drops, test in the car                                                                                                                                                            | Full drive with monitor + new-thread flows working                                 |
| 4 — Optional          | Upstream the notification work if clean; CarPlay investigation                                                                                                                                                                                                 | —                                                                                  |

## Dev environment

- Node + `vp` per root `package.json` engines; `vp i` installs.
- Android Studio with Android SDK, `androidx.car.app`, and the Desktop Head Unit (DHU) emulator.
- Expo + EAS CLI logged into the fork owner's Expo account.
- Physical Android phone with Developer mode; Android Auto developer settings with "Unknown sources" enabled (sideloaded builds don't show on the car screen otherwise).
- At least one remote T3 Code server reachable from the phone (Tailscale or LAN) with a pairing code; a second one to prove environment switching.

## Testing and distribution

- Android: `eas build --profile preview:dev --platform android` → internal APK → DHU emulator → car. The `preview:dev` profile already sets `buildType: apk` and `developmentClient: true`.
- iOS: TestFlight works for the phone app, but there is no Android Auto equivalent; CarPlay is a separate effort.

## Open questions

- [x] FCM: option B, socket-only. The app builds with no `google-services.json` and treats a failed push-token lookup as notifications off, so nothing is stripped.
- [x] Clerk / T3 Connect: nothing to strip. Every Clerk surface is gated on `hasCloudPublicConfig()`, so a build with no Clerk keys only offers manual pairing.
- [x] Android package: `com.mikeallisonjs.t3code` (production) and `com.mikeallisonjs.t3code.preview` (preview). The development variant keeps upstream's `com.t3tools.t3code.dev` because `scripts/mobile-native-client.ts` and the `test-t3-mobile` skill hardcode it.
- [ ] Keeping the fork rebased on a fast-moving upstream: keep all car code in its own module and config plugins to limit conflicts.
