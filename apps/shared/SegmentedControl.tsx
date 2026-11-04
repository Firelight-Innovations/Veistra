/**
 * The small pill-group control every header in this workstream uses: Scene/Play
 * in the Godot Viewer, Editor/Renders/Compare in the Blender app. Markup follows
 * the design system's own Tabs component (`src/veistra-ui.css`'s `.k-tabs--segmented`
 * variant — `.k-tabs[role=tablist]` wrapping `.k-tab[role=tab]` children) rather
 * than a hand-rolled equivalent, per `docs/design-notes/` (see
 * `tokens-merged.md`'s note to use the shared classes where they fit).
 */
/**
 * One option. A `disabled` one is drawn but cannot be chosen, and `title` says
 * why: Compare in the Blender app is on the board before it is built. It is
 * `aria-disabled` rather than `disabled`, so it keeps its tooltip and stays
 * reachable by keyboard.
 */
export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  "aria-label": string;
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className="k-tabs k-tabs--segmented" role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={opt.value === value}
          aria-disabled={opt.disabled || undefined}
          title={opt.title}
          className="k-tab"
          onClick={() => {
            if (!opt.disabled) onChange(opt.value);
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
