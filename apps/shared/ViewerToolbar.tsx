/**
 * The one toolbar Godot Play, Godot Scene and the Blender viewer share. The
 * design (`Components` board, "Toolbar: same five slots in every app") fixes
 * the order, so the three surfaces read as one product:
 *
 * 1. **Mode**: Scene · Play, or Model · Renders · Compare.
 * 2. **What you see**: the scene, take or `.blend` picker.
 * 3. **State**: one chip with one word (Playing, Reviewing, Up to date, Changed).
 * 4. **Actions**: Rec, Mark, Mark up, a view switch.
 * 5. **Leave**: Pop out, Open in Godot or Blender.
 *
 * Play also has transport buttons, which sit between the picker and the chip
 * (`controls`), as the board draws them. Everything else an app wants on its
 * header goes in one of the five; a sixth slot is how three toolbars start to
 * drift apart again, which is what this module exists to stop.
 *
 * The slots take nodes rather than descriptions of buttons. Each app's actions
 * are different verbs with different disabled rules and tooltips, and a
 * config object able to express all of them would be a second, worse JSX.
 */
import type { ReactNode } from "react";
import { SegmentedControl } from "./SegmentedControl";
import "./viewer-toolbar.css";

/** The chip's colour, from the design system's status set. */
export type ToolbarTone = "success" | "warning" | "danger" | "info" | "idle" | "accent";

export interface ToolbarStatus {
  tone: ToolbarTone;
  /** One word, or two: "Playing", "Up to date", "Changed after export". */
  label: string;
  title?: string;
}

export interface ToolbarMode<T extends string> {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

export interface ViewerToolbarProps<T extends string> {
  /** The toolbar's accessible name: the app, "Godot" or "Blender". */
  label: string;
  /** Slot 1. */
  mode?: ToolbarMode<T>;
  /** Slot 2: the picker. */
  subject?: ReactNode;
  /** Between 2 and 3: Play's pause, restart and stop. */
  controls?: ReactNode;
  /** Slot 3. */
  status?: ToolbarStatus | null;
  /** Slot 4, pushed to the right. */
  actions?: ReactNode;
  /** Slot 5, after a divider. */
  leave?: ReactNode;
}

export function ViewerToolbar<T extends string>({
  label,
  mode,
  subject,
  controls,
  status,
  actions,
  leave,
}: ViewerToolbarProps<T>) {
  return (
    <div className="k-vtb" role="toolbar" aria-label={label}>
      {mode && (
        <SegmentedControl
          aria-label="Mode"
          value={mode.value}
          options={mode.options}
          onChange={mode.onChange}
        />
      )}
      {subject}
      {controls != null && (
        <>
          <ToolbarDivider />
          <div className="k-vtb__group">{controls}</div>
        </>
      )}
      {status && <ToolbarChip {...status} />}
      <span className="k-vtb__spacer" />
      {actions != null && <div className="k-vtb__group k-vtb__actions">{actions}</div>}
      {leave != null && (
        <>
          <ToolbarDivider />
          <div className="k-vtb__group">{leave}</div>
        </>
      )}
    </div>
  );
}

/** Slot 3's chip: a dot and a word, in a status colour. */
export function ToolbarChip({ tone, label, title }: ToolbarStatus) {
  return (
    <span className={`k-vtb__chip k-vtb__chip--${tone}`} title={title} role="status">
      <span className="k-vtb__dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function ToolbarDivider() {
  return <span className="k-vtb__divider" aria-hidden="true" />;
}

/**
 * A labelled toolbar button, with the key that does the same thing shown
 * after the label (F8, Ctrl Shift M). `icon` alone, with no `children`, is the
 * square icon button the Leave slot uses; its label is then the tooltip and
 * the accessible name.
 */
export function ToolbarButton({
  icon,
  children,
  label,
  kbd,
  title,
  pressed,
  primary = false,
  disabled,
  onClick,
}: {
  icon?: ReactNode;
  children?: ReactNode;
  /** The accessible name when the button has no visible text. */
  label?: string;
  kbd?: string;
  title?: string;
  /** For toggles (Record): `aria-pressed`. */
  pressed?: boolean;
  primary?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const iconOnly = children == null;
  const classes = [
    "k-vtb__btn",
    iconOnly ? "k-vtb__btn--icon" : "",
    primary ? "k-vtb__btn--primary" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button
      type="button"
      className={classes}
      aria-label={iconOnly ? label : undefined}
      aria-pressed={pressed}
      title={title ?? (iconOnly ? label : undefined)}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {children}
      {kbd && <kbd className="k-vtb__kbd">{kbd}</kbd>}
    </button>
  );
}
