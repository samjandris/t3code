import { Context } from "effect";
import { Effect } from "effect";
import { Layer } from "effect";
import { Ref } from "effect";

export interface DesktopStateShape {
  readonly backendReady: Ref.Ref<boolean>;
  readonly quitting: Ref.Ref<boolean>;
}

export class DesktopState extends Context.Service<DesktopState, DesktopStateShape>()(
  "@t3tools/desktop/app/DesktopState",
) {}

export const layer = Layer.effect(
  DesktopState,
  Effect.all({
    backendReady: Ref.make(false),
    quitting: Ref.make(false),
  }),
);
