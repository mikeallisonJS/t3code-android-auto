import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import Constants from "expo-constants";

import { appAtomRegistry } from "../../state/atom-registry";
import { readEnvironmentScope } from "../../state/session";
import { environmentShell, environmentShellSummaryAtom } from "../../state/shell";
import {
  environmentThreadDetails,
  environmentThreadShells,
  threadEnvironment,
} from "../../state/threads";
import {
  answersFromSpeech,
  approvalDecisionFromSpeech,
  approvalSpeech,
  type CarAttention,
  type CarSpeech,
  diffCarAttention,
  questionSpeech,
  speakable,
} from "./carAttention";
import { carApp, type CarReplyMode } from "./carModule";

type CarApp = NonNullable<typeof carApp>;

type PendingReply =
  | {
      readonly kind: "approval";
      readonly thread: EnvironmentThreadShell;
      readonly approval: ThreadPendingApproval;
    }
  | {
      readonly kind: "input";
      readonly thread: EnvironmentThreadShell;
      readonly input: ThreadPendingUserInput;
    };

const threadKey = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;

function threadUrl(thread: EnvironmentThreadShell): string {
  const configured = Constants.expoConfig?.scheme;
  const scheme = (Array.isArray(configured) ? configured[0] : configured) ?? "t3code";
  return `${scheme}://threads/${encodeURIComponent(thread.environmentId)}/${encodeURIComponent(thread.id)}`;
}

/** Calls `use` once with the first value `select` accepts. Returns a cancel function. */
function onceAvailable<A, B>(
  atom: Atom.Atom<A>,
  select: (value: A) => B | null,
  use: (value: B) => void,
): () => void {
  let done = false;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    done = true;
    unsubscribe?.();
  };
  unsubscribe = appAtomRegistry.subscribe(
    atom,
    (value) => {
      if (done) return;
      const selected = select(value);
      if (selected === null) return;
      stop();
      use(selected);
    },
    { immediate: true },
  );
  // An immediate match ran before `unsubscribe` was assigned.
  if (done) unsubscribe();
  return stop;
}

function finishedSpeech(projection: OrchestrationV2ThreadProjection): string {
  const last = projection.visibleTurnItems.findLast(
    ({ item }) => item.type === "assistant_message" && !item.streaming,
  )?.item;
  const text = last?.type === "assistant_message" ? speakable(last.text) : "";
  return text.length > 0 ? `Finished. ${text}` : "Finished.";
}

function pendingSpeech(pending: PendingReply): CarSpeech {
  const canOperate = readEnvironmentScope(
    pending.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  return pending.kind === "approval"
    ? approvalSpeech(pending.approval, canOperate)
    : questionSpeech(pending.input, canOperate);
}

/** Announces threads that need the driver and routes spoken replies back, until stopped. */
function watchCarThreads(native: CarApp): () => void {
  let seen: ReadonlyMap<string, string | null> = new Map();
  const loading = new Map<string, () => void>();
  const awaitingReply = new Map<string, PendingReply>();

  const post = (thread: EnvironmentThreadShell, text: string, replyMode: CarReplyMode) =>
    native.postMessage(threadKey(thread), thread.title, text, threadUrl(thread), replyMode);

  const postPending = (pending: PendingReply, prefix = "") => {
    const speech = pendingSpeech(pending);
    const key = threadKey(pending.thread);
    if (speech.canReply) awaitingReply.set(key, pending);
    else awaitingReply.delete(key);
    post(
      pending.thread,
      `${prefix}${speech.text}`,
      speech.canReply ? (pending.kind === "approval" ? "approval" : "reply") : "none",
    );
  };

  const retract = (key: string) => {
    loading.get(key)?.();
    loading.delete(key);
    awaitingReply.delete(key);
    native.cancelMessage(key);
  };

  const announce = (key: string, thread: EnvironmentThreadShell, attention: CarAttention) => {
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    if (attention.kind === "failed") {
      const reason = speakable(thread.runtime?.lastError ?? "");
      post(thread, reason.length > 0 ? `The run failed. ${reason}` : "The run failed.", "none");
      return;
    }
    if (!("requestId" in attention)) {
      loading.set(
        key,
        onceAvailable(
          environmentThreadDetails.stateAtom(ref),
          // A cached projection may predate the run that just finished.
          (state) => (state.status === "live" ? Option.getOrNull(state.data) : null),
          (projection) => post(thread, finishedSpeech(projection), "none"),
        ),
      );
      return;
    }
    const { kind, requestId } = attention;
    loading.set(
      key,
      onceAvailable(
        environmentThreadDetails.pendingRequestsAtom(ref),
        (requests): PendingReply | null => {
          if (kind === "approval") {
            const approval = requests?.approvals.find((entry) => entry.requestId === requestId);
            return approval ? { kind, thread, approval } : null;
          }
          const input = requests?.userInputs.find((entry) => entry.requestId === requestId);
          return input ? { kind, thread, input } : null;
        },
        (pending) => postPending(pending),
      ),
    );
  };

  const refresh = () => {
    const live = new Map<EnvironmentId, boolean>();
    const isLive = (environmentId: EnvironmentId) => {
      let value = live.get(environmentId);
      if (value === undefined) {
        value =
          appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status === "live";
        live.set(environmentId, value);
      }
      return value;
    };
    // Cached rows can be stale, so only threads of live environments count.
    const threads = appAtomRegistry
      .get(environmentThreadShells.threadShellsAtom)
      .filter((thread) => isLive(thread.environmentId));
    const changes = diffCarAttention(seen, threads, threadKey);
    seen = changes.seen;
    for (const key of changes.retract) retract(key);
    for (const { threadKey: key, thread, attention } of changes.announce) {
      announce(key, thread, attention);
    }
  };

  const respond = async (key: string, speech: string) => {
    const pending = awaitingReply.get(key);
    if (pending === undefined) return;
    const { thread } = pending;
    const base = { environmentId: thread.environmentId } as const;
    awaitingReply.delete(key);
    let delivered: boolean;
    if (pending.kind === "approval") {
      const decision = approvalDecisionFromSpeech(speech);
      if (decision === null) return postPending(pending);
      const result = await runAtomCommand(appAtomRegistry, threadEnvironment.respondToApproval, {
        ...base,
        input: { threadId: thread.id, requestId: pending.approval.requestId, decision },
      });
      delivered = result._tag === "Success";
    } else {
      const answers = answersFromSpeech(pending.input, speech);
      if (answers === null) return postPending(pending);
      const result = await runAtomCommand(appAtomRegistry, threadEnvironment.respondToUserInput, {
        ...base,
        input: { threadId: thread.id, requestId: pending.input.requestId, answers },
      });
      delivered = result._tag === "Success";
    }
    // Ask again only if the same request is still the thread's open one.
    const requestId =
      pending.kind === "approval" ? pending.approval.requestId : pending.input.requestId;
    if (!delivered && seen.get(key) === `request:${requestId}`) {
      postPending(pending, "That did not go through. ");
    }
  };

  const replies = native.addListener("onCarMessageReply", (event) => {
    void respond(event.key, event.text);
  });
  const unsubscribers = [
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, refresh),
    appAtomRegistry.subscribe(environmentShellSummaryAtom, refresh),
  ];
  refresh();

  return () => {
    replies.remove();
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const cancel of loading.values()) cancel();
    loading.clear();
    awaitingReply.clear();
    native.cancelAllMessages();
  };
}

/**
 * Starts announcing threads through Android Auto whenever the car is
 * connected. Call once at startup.
 */
export function startCarMessages(): void {
  const native = carApp;
  if (native === null) return;
  let stop: (() => void) | null = null;
  const sync = (connected: boolean) => {
    if (connected && stop === null) {
      stop = watchCarThreads(native);
    } else if (!connected && stop !== null) {
      stop();
      stop = null;
    }
  };
  native.addListener("onCarConnectionChange", (event) => sync(event.connected));
  sync(native.isCarConnected());
}
