import { Context } from "effect";
import { Data } from "effect";
import type { Effect } from "effect";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export class ProjectSetupScriptRunnerError extends Data.TaggedError(
  "ProjectSetupScriptRunnerError",
)<{
  readonly message: string;
}> {}

export interface ProjectSetupScriptRunnerShape {
  readonly runForThread: (
    input: ProjectSetupScriptRunnerInput,
  ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
}

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  ProjectSetupScriptRunnerShape
>()("t3/project/Services/ProjectSetupScriptRunner") {}
