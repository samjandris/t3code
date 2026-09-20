import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { ActivityPublication } from "./publication.ts";

const state = (
  phase: RelayAgentActivityState["phase"],
  updatedAt = "2026-10-03T00:00:00.000Z",
): RelayAgentActivityState => ({
  environmentId: EnvironmentId.make("box"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Codex",
  headline: phase,
  phase,
  updatedAt,
  deepLink: "/threads/box/thread",
});

describe("activity publication", () => {
  it("preserves the published timestamp until meaningful activity changes", () => {
    const publication = new ActivityPublication();
    const running = state("running");
    publication.update([running], true, 0);
    expect(
      publication.update([{ ...running, updatedAt: "2026-10-03T00:00:01.000Z" }], false, 1_000),
    ).toBe(false);
    expect(publication.rows()).toEqual([running]);
    const renamed = { ...running, threadTitle: "New title", updatedAt: "2026-10-03T00:00:02.000Z" };
    expect(publication.update([renamed], false, 2_000)).toBe(true);
    expect(publication.rows()).toEqual([renamed]);
  });

  it("confirms a disappearance and cancels the deadline when activity recovers", () => {
    const publication = new ActivityPublication();
    const running = state("running");
    publication.update([running], true, 0);
    publication.update([], false, 1_000);
    publication.update([running], false, 2_000);
    expect(publication.rows()).toEqual([running]);
    publication.update([], false, 30_000);
    publication.update([], false, 34_999);
    expect(publication.rows()).toEqual([running]);
    publication.update([], false, 35_000);
    expect(publication.rows()).toEqual([]);
  });

  it("suppresses transient first completions but immediately publishes a real run finishing", () => {
    const publication = new ActivityPublication();
    publication.update([state("completed")], false, 0);
    expect(publication.rows()).toEqual([]);
    publication.update([state("running")], false, 1_000);
    expect(publication.rows()[0]?.phase).toBe("running");
    publication.update([state("completed")], false, 2_000);
    expect(publication.rows()[0]?.phase).toBe("completed");
  });

  it("publishes a confirmed first completion and seeds historical replay without alert deferral", () => {
    const publication = new ActivityPublication();
    publication.update([state("completed")], false, 0);
    publication.update([state("completed")], false, 4_999);
    expect(publication.rows()).toEqual([]);
    publication.update([state("completed")], false, 5_000);
    expect(publication.rows()[0]?.phase).toBe("completed");
    const replay = new ActivityPublication();
    replay.update([state("completed")], true, 0);
    expect(replay.rows()[0]?.phase).toBe("completed");
  });
});
