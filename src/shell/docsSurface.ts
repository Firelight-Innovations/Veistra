/**
 * Opening the Docs app from a surface that does not own the panes, such as
 * Settings' sidebar link. `WindowRoot` registers its Help ▸ Documentation
 * handler here; a caller asks for Docs without knowing which window or pane it
 * lands in. With no window to open it in, the documentation site opens in the
 * browser instead, so the link always goes somewhere.
 */
import { DOCS_URL, openExternal } from "./upgrade";

let opener: (() => void) | null = null;

/** Register the window's Docs opener. Returns the call that unregisters it. */
export function provideDocsOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Open the Docs app, or the documentation site where there is no window to hold it. */
export function openDocs(): void {
  if (opener !== null) opener();
  else openExternal(DOCS_URL);
}
