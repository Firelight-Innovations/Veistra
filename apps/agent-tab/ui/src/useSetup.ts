/**
 * The card that sets up the tab's harness when it cannot start: install it,
 * get Node.js for the installer, then sign in.
 *
 * Choosing a harness that is not installed is allowed (`harnesses.ts`), and
 * this is what the tab shows next. The Install button runs the vendor's own
 * installer through `agent-tab/install`, and the tab hears each step as
 * `agent-tab:install`. A fresh install is signed out, so the card then offers
 * the harness's own sign-in, the same one `/login` starts.
 */
import { useCallback, useEffect, useState } from "react";
import * as rpc from "./rpc";
import { strings } from "./strings";
import type { Harness, HarnessInfo } from "./protocol.generated";
import type { SetupCardProps } from "./components/types";

/** The refusals that stop an install before anything runs. */
const BLOCKED = ["nodeMissing", "shellMissing", "installing"] as const;
type BlockedCode = (typeof BLOCKED)[number];

/** Where the install this tab started stands. */
type Phase =
  | { kind: "running"; harness: Harness; step: "cli" | "adapter" }
  | { kind: "failed"; harness: Harness; detail: string | null }
  | { kind: "blocked"; harness: Harness; code: BlockedCode }
  | { kind: "installed"; harness: Harness };

function blockedCode(err: unknown): BlockedCode | null {
  const code = rpc.refusalOf(err)?.code;
  return BLOCKED.find((c) => c === code) ?? null;
}

/**
 * The setup card for `current`, the harness the tab's next prompt goes to, or
 * `null` when it needs none. `relist` asks for the harnesses again once an
 * install ends; `signIn` starts the harness's sign-in as `/login` does.
 */
export function useSetup(
  current: HarnessInfo | undefined,
  relist: () => void,
  signIn: () => void,
): SetupCardProps | null {
  const [phase, setPhase] = useState<Phase | null>(null);

  useEffect(
    () =>
      rpc.onInstall((progress) => {
        const { harness, step, ok, detail } = progress;
        if (step !== null && ok === null) setPhase({ kind: "running", harness, step });
        else if (step !== null) setPhase({ kind: "failed", harness, detail });
        else {
          setPhase((was) =>
            ok
              ? { kind: "installed", harness }
              : was?.kind === "failed"
                ? was
                : { kind: "failed", harness, detail: null },
          );
          relist();
        }
      }),
    [relist],
  );

  const install = useCallback((harness: Harness, step: "cli" | "adapter") => {
    setPhase({ kind: "running", harness, step });
    rpc.install(harness).catch((err: unknown) => {
      const code = blockedCode(err);
      setPhase(
        code ? { kind: "blocked", harness, code } : { kind: "failed", harness, detail: null },
      );
    });
  }, []);

  if (!current) return null;
  const { harness, name, hint, setup } = current;
  const mine = phase?.harness === harness ? phase : null;
  const step = hint === "adapterMissing" ? "adapter" : "cli";
  const retry = { label: strings.install.retry, onClick: () => install(harness, step) };
  const card = (fields: Partial<SetupCardProps> & { title: string }): SetupCardProps => ({
    body: null,
    typed: null,
    detail: null,
    actions: [],
    busy: false,
    ...fields,
  });

  if (mine?.kind === "running")
    return card({
      title:
        mine.step === "cli"
          ? strings.install.runningCli(name)
          : strings.install.runningAdapter(name),
      busy: true,
    });
  if (mine?.kind === "failed")
    return card({
      title: strings.install.failed(name),
      actions: [retry],
      detail: mine.detail ? { label: strings.install.details, text: mine.detail } : null,
    });
  if (mine?.kind === "blocked") {
    if (mine.code === "nodeMissing")
      return card({
        title: strings.install.needsNode(name),
        actions: [
          { label: strings.install.getNode, onClick: () => void rpc.getNode().catch(() => {}) },
          retry,
        ],
      });
    if (mine.code === "shellMissing")
      return card({
        title: strings.install.needsShell(name),
        typed: strings.install.typed(setup.cliInstall),
        actions: [retry],
      });
    return card({ title: strings.install.busy(name), busy: true });
  }
  if (hint === "harnessMissing" || hint === "adapterMissing")
    return card({
      title:
        hint === "harnessMissing"
          ? strings.install.missing(name)
          : strings.install.adapterMissing(name),
      body: strings.install.why(name),
      typed: strings.install.typed(
        hint === "harnessMissing" ? setup.cliInstall : setup.adapterInstall,
      ),
      actions: [{ label: strings.install.button(name), onClick: () => install(harness, step) }],
    });
  if (mine?.kind === "installed" && hint === null)
    return card({
      title: strings.install.done(name),
      actions: [
        {
          label: strings.install.signIn(name),
          onClick: () => {
            setPhase(null);
            signIn();
          },
        },
      ],
    });
  return null;
}
