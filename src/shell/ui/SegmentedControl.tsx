/**
 * A pill group over a handful of choices, in the design system's own
 * `.k-tabs--segmented` markup. The shell's counterpart of
 * `apps/shared/SegmentedControl.tsx`, which shell code may not import; the
 * settings rows draw their own segmented track (`controls/SelectControl.tsx`)
 * because theirs carries a setting's descriptions as tooltips.
 */
import "./ui.css";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export default function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  "aria-label": ariaLabel,
}: {
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
  "aria-label": string;
}) {
  return (
    <div className="k-tabs k-tabs--segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-selected={option.value === value}
          className="k-tab k-segment"
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
