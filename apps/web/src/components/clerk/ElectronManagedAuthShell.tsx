import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ManagedRelayAuthProvider } from "../../cloud/managedAuth";
import { clerkAppearance } from "./clerkAppearance";

const clerkPasskeysEnabled = import.meta.env.VITE_CLERK_PASSKEYS_ENABLED;

/** Load lazily inside desktop so the bundled clerk-js runtime stays out of other clients. */
export default function ElectronManagedAuthShell({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={clerkAppearance}
      publishableKey={publishableKey}
      {...(clerkPasskeysEnabled ? { passkeys } : {})}
    >
      <ManagedRelayAuthProvider>{children}</ManagedRelayAuthProvider>
    </ClerkProvider>
  );
}
