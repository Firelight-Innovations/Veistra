/**
 * The end of the line: a file this app has nothing useful to draw.
 *
 * Reached through `reopenWith("unsupported")` — from the text viewer when the
 * bytes are not UTF-8 — never through `pick`.
 *
 * What it deliberately does not do: offer a hex dump, or a "force open as text"
 * button. The first is a different app. The second is `reopenWith("text")` and
 * would loop straight back here, because getting here means the read already
 * failed.
 */
import { formatSize } from "../rpc";
import HandoffActions from "./HandoffActions";
import type { ViewerProps } from "./registry";
import "./media.css";

export default function UnsupportedViewer({ file }: ViewerProps) {
  /**
   * **This is not an error page.** Nothing went wrong and the user did nothing
   * wrong: they opened a `.zip`, and a file explorer that cannot preview a `.zip`
   * is a file explorer, not a broken one. So it states the fact in one line and
   * then spends its space on the two things that actually help — showing the file
   * in the OS file manager, and handing it to whatever the OS opens it with. No
   * red, no icon of a sad document, no "unsupported format" in a box with a
   * border.
   */
  return (
    <div className="unsupported">
      <div className="unsupported__body">
        <p className="unsupported__lead">There is no preview for this kind of file.</p>

        <p className="app__note unsupported__what">
          {file.name}
          {" · "}
          {file.ext === "" ? "no extension" : `.${file.ext}`}
          {file.size !== null && ` · ${formatSize(file.size)}`}
        </p>

        <HandoffActions path={file.path} />
      </div>
    </div>
  );
}
