import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
} from "@t3tools/client-runtime/state/thread-requests";
import type { ProviderApprovalDecision, RuntimeRequestId } from "@t3tools/contracts";

export type CarAttention =
  | {
      readonly kind: "approval" | "input";
      readonly key: string;
      readonly requestId: RuntimeRequestId;
    }
  | { readonly kind: "completed" | "failed"; readonly key: string };

/** The part of an `EnvironmentThreadShell` that decides whether it needs the driver. */
export interface AttentionThread {
  readonly archivedAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestRun: { readonly runId: string } | null;
  readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
  readonly runtime: { readonly status: string } | null;
  readonly source: {
    readonly pendingRuntimeRequest: { readonly id: RuntimeRequestId } | null;
  };
}

/**
 * What a thread wants from the driver right now, or null. `key` identifies the
 * event, so a thread is announced again only when it has something new to say.
 */
export function carAttention(thread: AttentionThread): CarAttention | null {
  if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") {
    return null;
  }
  const request = thread.source.pendingRuntimeRequest;
  if (request !== null && (thread.hasPendingApprovals || thread.hasPendingUserInput)) {
    return {
      kind: thread.hasPendingUserInput ? "input" : "approval",
      key: `request:${request.id}`,
      requestId: request.id,
    };
  }
  const status = thread.runtime?.status;
  if ((status === "completed" || status === "failed") && thread.latestRun !== null) {
    return { kind: status, key: `run:${thread.latestRun.runId}:${status}` };
  }
  return null;
}

export interface CarAttentionChanges<Thread> {
  /** Thread key to the attention key last seen for it. */
  readonly seen: ReadonlyMap<string, string | null>;
  readonly announce: ReadonlyArray<{
    readonly threadKey: string;
    readonly thread: Thread;
    readonly attention: CarAttention;
  }>;
  /** Threads whose earlier announcement no longer applies. */
  readonly retract: ReadonlyArray<string>;
}

/**
 * Compares the current threads with what was last seen and says what to
 * announce. A thread seen for the first time announces a pending request, since
 * that still needs the driver, but not a finished or failed run, which is
 * history from before the drive.
 */
export function diffCarAttention<Thread extends AttentionThread>(
  seen: ReadonlyMap<string, string | null>,
  threads: ReadonlyArray<Thread>,
  threadKey: (thread: Thread) => string,
): CarAttentionChanges<Thread> {
  const next = new Map<string, string | null>();
  const announce: Array<CarAttentionChanges<Thread>["announce"][number]> = [];
  const retract: string[] = [];
  for (const thread of threads) {
    const key = threadKey(thread);
    const attention = carAttention(thread);
    const previous = seen.get(key);
    next.set(key, attention?.key ?? null);
    if (previous === (attention?.key ?? null)) continue;
    if (previous !== undefined && previous !== null) retract.push(key);
    if (attention === null) continue;
    const isRequest = attention.kind === "approval" || attention.kind === "input";
    if (previous !== undefined || isRequest) announce.push({ threadKey: key, thread, attention });
  }
  for (const [key, previous] of seen) {
    if (!next.has(key) && previous !== null) retract.push(key);
  }
  return { seen: next, announce, retract };
}

const SPOKEN_LENGTH_LIMIT = 400;

/** Reduces markdown to something a text-to-speech voice can read without spelling out syntax. */
export function speakable(markdown: string, limit = SPOKEN_LENGTH_LIMIT): string {
  const text = markdown
    .replace(/```[\s\S]*?(```|$)/g, " (code omitted) ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : limit)}…`;
}

export interface CarSpeech {
  readonly text: string;
  /** False when the request has to be handled on the phone. */
  readonly canReply: boolean;
}

const USE_PHONE = "Open T3 Code on your phone to answer.";

/** `canOperate` is whether this connection may respond to requests at all. */
export function approvalSpeech(approval: ThreadPendingApproval, canOperate: boolean): CarSpeech {
  const subject = approval.detail ? speakable(approval.detail) : approval.requestKind;
  const canReply = canOperate && approval.responseCapability === "live";
  return {
    text: `Approval needed: ${subject}. ${canReply ? "Say approve or deny." : USE_PHONE}`,
    canReply,
  };
}

/** The one question a spoken reply can answer, or null when the request needs the phone. */
function voiceQuestion(input: ThreadPendingUserInput) {
  const [question, ...rest] = input.questions;
  if (question === undefined || rest.length > 0 || question.multiSelect) return null;
  return input.responseCapability === "live" && input.responseMode !== "message" ? question : null;
}

export function questionSpeech(input: ThreadPendingUserInput, canOperate: boolean): CarSpeech {
  const question = canOperate ? voiceQuestion(input) : null;
  if (question === null) {
    const first = input.questions[0];
    const lead = first ? `${speakable(first.question)} ` : "";
    return { text: `${lead}${USE_PHONE}`, canReply: false };
  }
  const options = question.options.map((option, index) => `${index + 1}, ${option.label}`);
  return {
    text:
      options.length > 0
        ? `${speakable(question.question)} Options: ${options.join(". ")}.`
        : speakable(question.question),
    canReply: true,
  };
}

function words(speech: string): string[] {
  return speech
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

const ACCEPT_WORDS = new Set(["yes", "yeah", "yep", "approve", "approved", "allow", "accept"]);
const DECLINE_WORDS = new Set(["no", "nope", "deny", "denied", "decline", "reject", "cancel"]);

/**
 * Reads an approval decision from speech. Only the first word counts, so a
 * hedged sentence such as "I don't approve" is not mistaken for consent.
 */
export function approvalDecisionFromSpeech(speech: string): ProviderApprovalDecision | null {
  const first = words(speech)[0];
  if (first === undefined) return null;
  if (ACCEPT_WORDS.has(first)) return "accept";
  return DECLINE_WORDS.has(first) ? "decline" : null;
}

const ORDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
const ORDINAL_ALIASES: Record<string, number> = { first: 0, second: 1, third: 2 };

function spokenOptionIndex(spoken: ReadonlyArray<string>): number | null {
  const candidate = spoken.filter((word) => word !== "option" && word !== "number");
  if (candidate.length !== 1) return null;
  const word = candidate[0]!;
  const alias = ORDINAL_ALIASES[word];
  if (alias !== undefined) return alias;
  const named = ORDINALS.indexOf(word);
  if (named >= 0) return named;
  return /^[1-9]$/.test(word) ? Number(word) - 1 : null;
}

/**
 * Turns a spoken reply into the answers payload for a question, or null when
 * the reply does not answer it: the question offers fixed options and the reply
 * names none of them.
 */
export function answersFromSpeech(
  input: ThreadPendingUserInput,
  speech: string,
): Record<string, string> | null {
  const question = voiceQuestion(input);
  const reply = speech.trim();
  if (question === null || reply.length === 0) return null;
  const spoken = words(reply);
  const byLabel = question.options.find(
    (option) => words(option.label).join(" ") === spoken.join(" "),
  );
  const index = spokenOptionIndex(spoken);
  const option = byLabel ?? (index === null ? undefined : question.options[index]);
  if (option !== undefined) return { [question.id]: option.value ?? option.label };
  return question.allowCustomAnswer === false ? null : { [question.id]: reply };
}
