import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import type { TextGenerationPolicy } from "./TextGenerationPolicy.ts";
import { ServerConfig } from "../config.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface CommitMessageGenerationResult {
  subject: string;
  body: string;
  /** Only present when `includeBranch` was set on the input. */
  branch?: string | undefined;
}

export interface PrContentGenerationInput {
  cwd: string;
  baseBranch: string;
  headBranch: string;
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
  changeRequestTemplate?: string | undefined;
  policy?: TextGenerationPolicy | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface PrContentGenerationResult {
  title: string;
  body: string;
}

export interface BranchNameGenerationInput {
  cwd: string;
  message: string;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface BranchNameGenerationResult {
  branch: string;
}

export interface ThreadTitleGenerationInput {
  cwd: string;
  message: string;
  /** Present when replacing an existing title from the current thread history. */
  previousTitle?: string | undefined;
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface ToolCallSummariesGenerationItem {
  id: string;
  toolName: string;
  toolType: string;
  status?: string | undefined;
  detail?: string | undefined;
  payload: string;
}

export interface ToolCallSummariesGenerationInput {
  cwd: string;
  items: ReadonlyArray<ToolCallSummariesGenerationItem>;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ToolCallSummariesGenerationResult {
  summaries: ReadonlyArray<{
    id: string;
    summary: string;
  }>;
}

export interface TextGenerationService {
  generateCommitMessage(
    input: CommitMessageGenerationInput,
  ): Promise<CommitMessageGenerationResult>;
  generatePrContent(input: PrContentGenerationInput): Promise<PrContentGenerationResult>;
  generateBranchName(input: BranchNameGenerationInput): Promise<BranchNameGenerationResult>;
  generateThreadTitle(input: ThreadTitleGenerationInput): Promise<ThreadTitleGenerationResult>;
  generateToolCallSummaries?(
    input: ToolCallSummariesGenerationInput,
  ): Promise<ToolCallSummariesGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<
  TextGeneration,
  {
    /**
     * Generate a commit message from staged change context.
     */
    readonly generateCommitMessage: (
      input: CommitMessageGenerationInput,
    ) => Effect.Effect<CommitMessageGenerationResult, TextGenerationError>;

    /**
     * Generate change request title/body from branch and diff context.
     */
    readonly generatePrContent: (
      input: PrContentGenerationInput,
    ) => Effect.Effect<PrContentGenerationResult, TextGenerationError>;

    /**
     * Generate a concise branch name from a user message.
     */
    readonly generateBranchName: (
      input: BranchNameGenerationInput,
    ) => Effect.Effect<BranchNameGenerationResult, TextGenerationError>;

    /** Generate a concise thread title from a first message or thread history. */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

    /**
     * Generate concise work-log summaries for completed provider tool calls in one model request.
     */
    readonly generateToolCallSummaries?: (
      input: ToolCallSummariesGenerationInput,
    ) => Effect.Effect<ToolCallSummariesGenerationResult, TextGenerationError>;
  }
>()("t3/textGeneration/TextGeneration") {}

/** @deprecated Use `TextGeneration["Service"]`. */
export type TextGenerationShape = TextGeneration["Service"];

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle"
  | "generateToolCallSummaries";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

export const makeTextGenerationFromRegistry = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  options?: { readonly textGenerationCwd?: string | undefined },
): TextGeneration["Service"] =>
  TextGeneration.of({
    generateCommitMessage: (input) =>
      resolveInstance(registry, "generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateCommitMessage(input)),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generatePrContent(input)),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateBranchName(input)),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => textGeneration.generateThreadTitle(input)),
      ),
    generateToolCallSummaries: (input) =>
      resolveInstance(registry, "generateToolCallSummaries", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => {
          const generateToolCallSummaries = textGeneration.generateToolCallSummaries;
          return generateToolCallSummaries
            ? generateToolCallSummaries(withTextGenerationCwd(input, options))
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateToolCallSummaries",
                  detail: `Provider instance '${input.modelSelection.instanceId}' does not support tool call summaries.`,
                }),
              );
        }),
      ),
  });

function resolveTextGenerationCwd(
  fallbackCwd: string,
  options: { readonly textGenerationCwd?: string | undefined } | undefined,
): string {
  return options?.textGenerationCwd ?? fallbackCwd;
}

function withTextGenerationCwd<T extends { readonly cwd: string }>(
  input: T,
  options: { readonly textGenerationCwd?: string | undefined } | undefined,
): T {
  const cwd = resolveTextGenerationCwd(input.cwd, options);
  return cwd === input.cwd ? input : { ...input, cwd };
}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
  return makeTextGenerationFromRegistry(registry, {
    textGenerationCwd: config?.textGenerationCwd,
  });
});

export const layer = Layer.effect(TextGeneration, make);
