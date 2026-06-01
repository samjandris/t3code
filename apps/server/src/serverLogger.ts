import { Effect } from "effect";
import { Logger } from "effect";
import { References } from "effect";
import { Layer } from "effect";

import { ServerConfig } from "./config.ts";

export const ServerLoggerLive = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const minimumLogLevelLayer = Layer.succeed(References.MinimumLogLevel, config.logLevel);
  const loggerLayer = Logger.layer([Logger.consolePretty(), Logger.tracerLogger], {
    mergeWithExisting: false,
  });

  return Layer.mergeAll(loggerLayer, minimumLogLevelLayer);
}).pipe(Layer.unwrap);
