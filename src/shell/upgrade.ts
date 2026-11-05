/**
 * Where Upgrade goes, for the two places that offer it: the title bar's text
 * button and the plan card on Settings' Billing page. A shared leaf so the two
 * cannot point at different pages, and so neither region imports the other.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

/** Until there is a plans page of our own to send people to. */
export const UPGRADE_URL = "https://veistra.com";

/** Where Settings' Docs link goes: Veistra's documentation site. */
export const DOCS_URL = "https://veistra.com/docs";

/** Open a page in the system browser. A failure is logged; there is nothing to undo. */
export function openExternal(url: string): void {
  openUrl(url).catch((err: unknown) => console.error(`veistra: could not open ${url}:`, err));
}
