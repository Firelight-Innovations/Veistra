/**
 * Every feature this build reports on, in the order the feedback dialog lists
 * them and the order prompts are considered in.
 *
 * Adding a feature is a file beside this one and a line here — see
 * `docs/telemetry.md` §4. `registry.test.ts` checks the list is coherent: no
 * two features or prompts share an id, every prompt waits on an event its own
 * feature declares, and no app reports for two features.
 */
import type { Feature } from "../define";
import { agentTab } from "./agentTab";
import { feedback } from "./feedback";
import { general } from "./general";
import { shell } from "./shell";

export { agentTab, feedback, general, shell };

export const FEATURES: readonly Feature[] = [general, agentTab, shell, feedback];
