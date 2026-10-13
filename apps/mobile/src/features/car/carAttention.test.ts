import { describe, expect, it } from "@effect/vitest";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { RuntimeRequestId } from "@t3tools/contracts";

import {
  answersFromSpeech,
  approvalDecisionFromSpeech,
  type AttentionThread,
  diffCarAttention,
  questionSpeech,
  speakable,
} from "./carAttention";

type TestThread = AttentionThread & { readonly id: string };

function thread(id: string, overrides: Partial<AttentionThread> = {}): TestThread {
  return {
    id,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestRun: { runId: "run-1" },
    lineage: { relationshipToParent: null },
    runtime: { status: "running" },
    source: { pendingRuntimeRequest: null },
    ...overrides,
  };
}

const waitingOnApproval = (id: string, requestId: string) =>
  thread(id, {
    hasPendingApprovals: true,
    source: { pendingRuntimeRequest: { id: RuntimeRequestId.make(requestId) } },
  });

const finished = (id: string) => thread(id, { runtime: { status: "completed" } });

const diff = (seen: ReadonlyMap<string, string | null>, threads: ReadonlyArray<TestThread>) =>
  diffCarAttention(seen, threads, (entry) => entry.id);

describe("diffCarAttention", () => {
  it("announces an open request on first sight but not a run that already finished", () => {
    const changes = diff(new Map(), [waitingOnApproval("a", "req-1"), finished("b")]);

    expect(changes.announce.map((entry) => [entry.threadKey, entry.attention.kind])).toEqual([
      ["a", "approval"],
    ]);
    expect(changes.retract).toEqual([]);
  });

  it("announces a run that finishes during the drive exactly once", () => {
    const working = diff(new Map(), [thread("a")]);
    const done = diff(working.seen, [finished("a")]);
    const unchanged = diff(done.seen, [finished("a")]);

    expect(done.announce.map((entry) => entry.attention.kind)).toEqual(["completed"]);
    expect(unchanged.announce).toEqual([]);
  });

  it("retracts a request answered elsewhere and announces the next one", () => {
    const first = diff(new Map(), [waitingOnApproval("a", "req-1")]);
    const second = diff(first.seen, [waitingOnApproval("a", "req-2")]);
    const answered = diff(second.seen, [thread("a")]);

    expect(second.retract).toEqual(["a"]);
    expect(second.announce.map((entry) => entry.attention.key)).toEqual(["request:req-2"]);
    expect(answered.retract).toEqual(["a"]);
    expect(answered.announce).toEqual([]);
  });

  it("retracts the announcement of a thread that is no longer listed", () => {
    const first = diff(new Map(), [waitingOnApproval("a", "req-1")]);

    expect(diff(first.seen, []).retract).toEqual(["a"]);
  });

  it("ignores subagent and archived threads", () => {
    const changes = diff(new Map(), [
      { ...waitingOnApproval("a", "req-1"), lineage: { relationshipToParent: "subagent" } },
      { ...waitingOnApproval("b", "req-2"), archivedAt: "2026-10-12T00:00:00.000Z" },
    ]);

    expect(changes.announce).toEqual([]);
  });
});

describe("approvalDecisionFromSpeech", () => {
  it("reads a decision from the first word only", () => {
    expect(approvalDecisionFromSpeech("Yes, please.")).toBe("accept");
    expect(approvalDecisionFromSpeech("approve it")).toBe("accept");
    expect(approvalDecisionFromSpeech("No way, approve nothing")).toBe("decline");
    expect(approvalDecisionFromSpeech("Deny")).toBe("decline");
  });

  it("does not treat a hedged or unrelated reply as consent", () => {
    expect(approvalDecisionFromSpeech("I don't approve")).toBeNull();
    expect(approvalDecisionFromSpeech("what does it do")).toBeNull();
    expect(approvalDecisionFromSpeech("  ")).toBeNull();
  });
});

function userInput(
  question: Partial<ThreadPendingUserInput["questions"][number]>,
  overrides: Partial<ThreadPendingUserInput> = {},
): ThreadPendingUserInput {
  return {
    requestId: RuntimeRequestId.make("req-1"),
    createdAt: "2026-10-12T00:00:00.000Z",
    questions: [
      {
        id: "q1",
        header: "Target",
        question: "Which branch should I use?",
        options: [],
        multiSelect: false,
        ...question,
      },
    ],
    responseCapability: "live",
    dismissible: false,
    ...overrides,
  };
}

const branchOptions = [
  { label: "Main", description: "The default branch", value: "main" },
  { label: "A new branch", description: "Create one" },
];

describe("answersFromSpeech", () => {
  it("uses free speech as the answer to an open question", () => {
    expect(answersFromSpeech(userInput({}), " Use the release branch. ")).toEqual({
      q1: "Use the release branch.",
    });
  });

  it("matches an option by its label or its position", () => {
    const input = userInput({ options: branchOptions });

    expect(answersFromSpeech(input, "main")).toEqual({ q1: "main" });
    expect(answersFromSpeech(input, "A new branch!")).toEqual({ q1: "A new branch" });
    expect(answersFromSpeech(input, "option two")).toEqual({ q1: "A new branch" });
    expect(answersFromSpeech(input, "1")).toEqual({ q1: "main" });
  });

  it("rejects a reply that names no option when custom answers are not allowed", () => {
    const input = userInput({ options: branchOptions, allowCustomAnswer: false });

    expect(answersFromSpeech(input, "whatever you think")).toBeNull();
    expect(answersFromSpeech(input, "option five")).toBeNull();
  });

  it("leaves requests a single utterance cannot answer to the phone", () => {
    const base = userInput({});
    const twoQuestions = { ...base, questions: [...base.questions, ...base.questions] };

    expect(answersFromSpeech(twoQuestions, "main")).toBeNull();
    expect(questionSpeech(twoQuestions, true).canReply).toBe(false);
    expect(questionSpeech(userInput({}, { responseCapability: "not_resumable" }), true)).toEqual({
      text: "Which branch should I use? Open T3 Code on your phone to answer.",
      canReply: false,
    });
    expect(questionSpeech(base, false).canReply).toBe(false);
  });
});

describe("speakable", () => {
  it("drops code blocks and markdown syntax", () => {
    expect(
      speakable("## Done\n\nI **fixed** `parse()`:\n```ts\nconst a = 1;\n```\nSee [docs](x)."),
    ).toBe("Done I fixed parse(): (code omitted) See docs.");
  });

  it("truncates long text at a word boundary", () => {
    expect(speakable("alpha beta gamma delta", 12)).toBe("alpha beta…");
  });
});
