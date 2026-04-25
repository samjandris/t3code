import { Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { PiModelSelection, TextGenerationError } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { ServerSettingsService } from "../../serverSettings.ts";
import { type TextGenerationShape, TextGeneration } from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  extractJsonObject,
  normalizeCliError,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";

const PI_TIMEOUT_MS = 180_000;

const makePiTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettingsService = yield* ServerSettingsService;

  const readStreamAsString = <E>(
    operation: string,
    stream: Stream.Stream<Uint8Array, E>,
  ): Effect.Effect<string, TextGenerationError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
      Effect.mapError((cause) =>
        normalizeCliError("pi", operation, cause, "Failed to collect process output"),
      ),
    );

  const runPiJson = Effect.fn("runPiJson")(function* <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: PiModelSelection;
  }): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
    const piSettings = yield* Effect.map(
      serverSettingsService.getSettings,
      (settings) => settings.providers.pi,
    ).pipe(Effect.catch(() => Effect.undefined));

    const jsonPrompt = `${prompt}\n\nReturn only valid JSON. Do not include Markdown fences or commentary.`;
    const runPiCommand = Effect.fn("runPiJson.runPiCommand")(function* () {
      const command = ChildProcess.make(
        piSettings?.binaryPath || "pi",
        ["-p", ...(modelSelection.model !== "auto" ? ["--model", modelSelection.model] : [])],
        {
          cwd,
          env: {
            ...process.env,
            ...(piSettings?.configDir ? { PI_CODING_AGENT_DIR: piSettings.configDir } : {}),
          },
          shell: process.platform === "win32",
          stdin: {
            stream: Stream.encodeText(Stream.make(jsonPrompt)),
          },
        },
      );

      const child = yield* commandSpawner
        .spawn(command)
        .pipe(
          Effect.mapError((cause) =>
            normalizeCliError("pi", operation, cause, "Failed to spawn Pi CLI process"),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          readStreamAsString(operation, child.stdout),
          readStreamAsString(operation, child.stderr),
          child.exitCode.pipe(
            Effect.mapError((cause) =>
              normalizeCliError("pi", operation, cause, "Failed to read Pi CLI exit code"),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      if (exitCode !== 0) {
        const detail = stderr.trim() || stdout.trim();
        return yield* new TextGenerationError({
          operation,
          detail:
            detail.length > 0
              ? `Pi CLI command failed: ${detail}`
              : `Pi CLI command failed with code ${exitCode}.`,
        });
      }
      return stdout;
    });

    const rawStdout = yield* runPiCommand().pipe(
      Effect.scoped,
      Effect.timeoutOption(PI_TIMEOUT_MS),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new TextGenerationError({ operation, detail: "Pi CLI request timed out." }),
            ),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
      extractJsonObject(rawStdout),
    ).pipe(
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "Pi returned invalid structured output.",
            cause,
          }),
        ),
      ),
    );
  });

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "PiTextGeneration.generateCommitMessage",
  )(function* (input) {
    if (input.modelSelection.provider !== "pi") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });
    const generated = yield* runPiJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "PiTextGeneration.generatePrContent",
  )(function* (input) {
    if (input.modelSelection.provider !== "pi") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildPrContentPrompt(input);
    const generated = yield* runPiJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "PiTextGeneration.generateBranchName",
  )(function* (input) {
    if (input.modelSelection.provider !== "pi") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildBranchNamePrompt(input);
    const generated = yield* runPiJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { branch: sanitizeBranchFragment(generated.branch) };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "PiTextGeneration.generateThreadTitle",
  )(function* (input) {
    if (input.modelSelection.provider !== "pi") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }
    const { prompt, outputSchema } = buildThreadTitlePrompt(input);
    const generated = yield* runPiJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });
    return { title: sanitizeThreadTitle(generated.title) };
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGenerationShape;
});

export const PiTextGenerationLive = Layer.effect(TextGeneration, makePiTextGeneration);
