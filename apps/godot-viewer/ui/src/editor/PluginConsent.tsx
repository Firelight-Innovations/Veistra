/**
 * "Add the Veistra plugin to <project>?", asked as a modal over the whole
 * frame. Editor mode asks it by itself when it opens on a project that has no
 * plugin, before it starts the editor, and again whenever Enable or Update the
 * plugin is pressed. The scrim is the shell's palette scrim (`--bg-backdrop`,
 * `src/shell/palette/palette.css`), drawn inside this frame since the app is
 * an iframe and can dim only its own viewport.
 *
 * Tab stays between the two buttons, Escape is Not now, and a press on the
 * scrim does nothing: Not now is remembered for the project, so it is never
 * said by a stray click.
 */
import { useEffect, useRef } from "react";

export interface PluginConsentProps {
  /** The project's name, for the question. */
  name: string;
  /** The project folder relative to the environment root, `.` for the root. */
  rel: string;
  /** An answer is being carried out: both buttons wait, and Escape does nothing. */
  busy: boolean;
  onAdd: () => void;
  onNotNow: () => void;
}

export default function PluginConsent({ name, rel, busy, onAdd, onNotNow }: PluginConsentProps) {
  const dialog = useRef<HTMLDivElement>(null);
  const add = useRef<HTMLButtonElement>(null);

  // The focus goes in on the question and back where it was once it is answered.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    add.current?.focus();
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy) onNotNow();
        return;
      }
      if (e.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const at = document.activeElement;
      // Focus outside the dialog, as after a click on the scrim, comes back in too.
      if (!dialog.current.contains(at)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && at === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, onNotNow]);

  return (
    <div className="ge__scrim">
      <div
        className="ge__consent"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Enable the Veistra plugin"
      >
        <strong className="ge__consent-title">Add the Veistra plugin to {name}?</strong>
        <ul>
          <li>
            Four files, <code>addons/veistra/plugin.cfg</code>,{" "}
            <code>addons/veistra/veistra_editor.gd</code>,{" "}
            <code>addons/veistra/veistra_dock.gd</code> and{" "}
            <code>addons/veistra/veistra_menu.gd</code>, and one <code>[editor_plugins]</code> line
            in <code>{rel === "." ? "" : `${rel}/`}project.godot</code>.
          </li>
          <li>
            While the editor runs from Veistra it reports the selected nodes, the edited scene and
            its nodes, the 3D camera and a picture of the viewport. It takes four commands, select a
            node, open a scene, open a script or resource and Viewport only, and saves the editor
            when you press Save all here.
          </li>
          <li>
            It adds a Veistra dock to the editor with the notes on the selected node, and Mention in
            agent on the dock, on Ctrl+Alt+M and on the right-click menus. Its buttons ask Veistra
            to act; the dock never writes the notes itself.
          </li>
          <li>It talks to Veistra through a temporary folder. No network port.</li>
          <li>
            It does nothing in an exported build, or when you open the project in Godot yourself.
            Remove it here at any time.
          </li>
        </ul>
        <div className="ge__consent-actions">
          <button
            type="button"
            className="k-btn k-btn--secondary k-btn--sm"
            disabled={busy}
            onClick={onNotNow}
          >
            Not now
          </button>
          <button
            type="button"
            ref={add}
            className="k-btn k-btn--primary k-btn--sm"
            disabled={busy}
            onClick={onAdd}
          >
            Add to this project
          </button>
        </div>
      </div>
    </div>
  );
}
