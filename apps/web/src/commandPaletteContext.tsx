import { createContext, use, useMemo, type ReactNode } from "react";

interface CommandPaletteActions {
  readonly open: () => void;
  readonly openAddProject: () => void;
}

const CommandPaletteActionsContext = createContext<CommandPaletteActions | null>(null);

export function OpenAddProjectCommandPaletteProvider(props: {
  readonly children: ReactNode;
  readonly open: () => void;
  readonly openAddProject: () => void;
}) {
  const value = useMemo(
    () => ({ open: props.open, openAddProject: props.openAddProject }),
    [props.open, props.openAddProject],
  );

  return (
    <CommandPaletteActionsContext value={value}>{props.children}</CommandPaletteActionsContext>
  );
}

export function useOpenCommandPalette(): () => void {
  const actions = use(CommandPaletteActionsContext);
  if (!actions) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return actions.open;
}

export function useOpenAddProjectCommandPalette(): () => void {
  const actions = use(CommandPaletteActionsContext);
  if (!actions) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return actions.openAddProject;
}

/** Read at event time so the chat tree does not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
