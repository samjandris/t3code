import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { ChatAttachment, ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ServerConfig } from "../config.ts";

export type TextGenerationProvider = "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";

export interface CommitMessageGenerationInput {
  cwd: string;
  branch: string | null;
  stagedSummary: string;
  stagedPatch: string;
  /** When true, the model also returns a semantic branch name for the change. */
  includeBranch?: boolean;
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
  attachments?: ReadonlyArray<ChatAttachment> | undefined;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ThreadTitleGenerationResult {
  title: string;
}

export interface ToolCallSummaryGenerationInput {
  cwd: string;
  toolName: string;
  toolType: string;
  status?: string | undefined;
  detail?: string | undefined;
  payload: string;
  /** What model and provider to use for generation. */
  modelSelection: ModelSelection;
}

export interface ToolCallSummaryGenerationResult {
  summary: string;
}

export interface ToolCallSummariesGenerationItem extends Omit<
  ToolCallSummaryGenerationInput,
  "cwd" | "modelSelection"
> {
  id: string;
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
  generateToolCallSummary?(
    input: ToolCallSummaryGenerationInput,
  ): Promise<ToolCallSummaryGenerationResult>;
  generateToolCallSummaries?(
    input: ToolCallSummariesGenerationInput,
  ): Promise<ToolCallSummariesGenerationResult>;
}

/**
 * TextGeneration - Service tag for commit and PR text generation.
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
     * Generate pull request title/body from branch and diff context.
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

    /**
     * Generate a concise thread title from a user's first message.
     */
    readonly generateThreadTitle: (
      input: ThreadTitleGenerationInput,
    ) => Effect.Effect<ThreadTitleGenerationResult, TextGenerationError>;

    /**
     * Generate a concise work-log summary for a completed provider tool call.
     */
    readonly generateToolCallSummary?: (
      input: ToolCallSummaryGenerationInput,
    ) => Effect.Effect<ToolCallSummaryGenerationResult, TextGenerationError>;

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
  | "generateToolCallSummary"
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
        Effect.flatMap((textGeneration) =>
          textGeneration.generateCommitMessage(withTextGenerationCwd(input, options)),
        ),
      ),
    generatePrContent: (input) =>
      resolveInstance(registry, "generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generatePrContent(withTextGenerationCwd(input, options)),
        ),
      ),
    generateBranchName: (input) =>
      resolveInstance(registry, "generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateBranchName(withTextGenerationCwd(input, options)),
        ),
      ),
    generateThreadTitle: (input) =>
      resolveInstance(registry, "generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateThreadTitle(withTextGenerationCwd(input, options)),
        ),
      ),
    generateToolCallSummary: (input) =>
      resolveInstance(registry, "generateToolCallSummary", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          textGeneration.generateToolCallSummary
            ? textGeneration.generateToolCallSummary(withTextGenerationCwd(input, options))
            : Effect.fail(
                new TextGenerationError({
                  operation: "generateToolCallSummary",
                  detail: `Provider instance '${input.modelSelection.instanceId}' does not support tool call summaries.`,
                }),
              ),
        ),
      ),
    generateToolCallSummaries: (input) =>
      resolveInstance(registry, "generateToolCallSummaries", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => {
          const generateToolCallSummaries = textGeneration.generateToolCallSummaries;
          if (generateToolCallSummaries) {
            return generateToolCallSummaries(withTextGenerationCwd(input, options));
          }

          const generateToolCallSummary = textGeneration.generateToolCallSummary;
          if (!generateToolCallSummary) {
            return Effect.fail(
              new TextGenerationError({
                operation: "generateToolCallSummaries",
                detail: `Provider instance '${input.modelSelection.instanceId}' does not support tool call summaries.`,
              }),
            );
          }

          return Effect.forEach(input.items, (item) =>
            generateToolCallSummary({
              cwd: resolveTextGenerationCwd(input.cwd, options),
              modelSelection: input.modelSelection,
              toolName: item.toolName,
              toolType: item.toolType,
              ...(item.status ? { status: item.status } : {}),
              ...(item.detail ? { detail: item.detail } : {}),
              payload: item.payload,
            }).pipe(Effect.map((result) => ({ id: item.id, summary: result.summary }))),
          ).pipe(Effect.map((summaries) => ({ summaries })));
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
