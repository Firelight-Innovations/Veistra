/**
 * What a sent message's chip can open, from the tab around it: a chip naming
 * a Godot node, a scene or a Blender object shows it in that editor's pane.
 * Without a provider, as in a test that renders one message, no chip opens.
 */
import { createContext } from "react";

export interface ChipOpener {
  /** Whether a click on the chip pointing at `uri` shows something. */
  opens(uri: string): boolean;
  open(uri: string): void;
}

export const ChipOpen = createContext<ChipOpener | null>(null);
