import { BrandGlyph } from "../../ui/Icon";

/**
 * Reached when the active cluster has nothing open — on first launch, and after
 * the last tab in it is closed or dragged away. Measured from SCREEN 02
 * (docs/handoffs/shell-spec.html). No dashed inset border here — that belongs to
 * the boot overlay only; screen 02's markup draws none.
 *
 * The title and one button, "Open an app", which raises the same picker the `+`
 * on a pane's tab strip does. No sentence between them: it only restated the
 * button and the Apps menu, and the person asked for it gone.
 */
export default function EmptyState({ onOpenApp }: { onOpenApp?: () => void }) {
  return (
    <div className="toolwindow__empty">
      <div className="toolwindow__empty-column">
        <BrandGlyph size={38} className="toolwindow__empty-glyph" />
        <div className="toolwindow__empty-title">Nothing open here</div>
        {onOpenApp && (
          <button type="button" className="toolwindow__empty-action" onClick={onOpenApp}>
            Open an app
          </button>
        )}
      </div>
    </div>
  );
}
