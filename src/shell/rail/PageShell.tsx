import { forwardRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ChevronLeft, Maximize2, X } from "lucide-react";
import { instant } from "../motion";
import "./dockedpage.css";
import "./expandedpage.css";

export interface PageShellProps {
  /** Which of the two headers to draw, and which geometry `Frame` has put this in. */
  mode: "docked" | "expanded";
  /** The open page's id. Changing it crossfades the body in; nothing else does. */
  pageId: string;
  title: string;
  /** The cluster the expanded header's "back" button names. */
  backLabel: string;
  /** Closes the page. The docked X, the expanded back button and Esc all mean this. */
  onClose: () => void;
  /** Docked only: expand the page over the workspace, the same toggle as Ctrl+Shift+E. */
  onExpand?: () => void;
  children: ReactNode;
}

/**
 * The docked and the expanded page, as one component.
 *
 * `Frame` draws one surface whose geometry changes between the two modes, and
 * an app page's iframe is portalled into a host div inside `children`. Two
 * component types (`DockedPage`, `ExpandedPage`) would make React unmount the
 * host on every dock/expand toggle and reload the iframe. One type, with the
 * header switched inside it and the body always the second child, keeps that
 * host mounted across the toggle: only class names and the header change.
 *
 * The root is focusable (`tabIndex -1`) so `WindowRoot` can land focus in the
 * page after it opens, which an app's iframe cannot be handed from outside.
 */
const PageShell = forwardRef<HTMLDivElement, PageShellProps>(function PageShell(
  { mode, pageId, title, backLabel, onClose, onExpand, children },
  ref,
) {
  const base = mode === "docked" ? "k-docked-page" : "k-expanded-page";
  // The page opens instantly, so the body it opens with is drawn at once; only
  // a later switch to another page fades. Derived during render rather than in
  // an effect, so the first switch's body already mounts with its fade.
  const [shownPage, setShownPage] = useState(pageId);
  const [switched, setSwitched] = useState(false);
  if (pageId !== shownPage) {
    setShownPage(pageId);
    setSwitched(true);
  }
  return (
    <div className={base} aria-label={title} data-page-id={pageId} tabIndex={-1} ref={ref}>
      {mode === "docked" ? (
        <header className="k-docked-page__header">
          <span className="k-docked-page__title">{title}</span>
          {onExpand && (
            <button
              type="button"
              className="k-docked-page__expand"
              aria-label={`Expand ${title}`}
              title="Expand (Ctrl+Shift+E)"
              onClick={onExpand}
            >
              <Maximize2 size={14} strokeWidth={1.6} aria-hidden />
            </button>
          )}
          <button
            type="button"
            className="k-docked-page__close"
            aria-label={`Close ${title}`}
            onClick={onClose}
          >
            <X size={14} strokeWidth={1.6} aria-hidden />
          </button>
        </header>
      ) : (
        <header className="k-expanded-page__header">
          <button type="button" className="k-expanded-page__back" onClick={onClose}>
            <ChevronLeft size={14} strokeWidth={1.6} aria-hidden />
            <span>{backLabel}</span>
            <span className="k-expanded-page__esc">Esc</span>
          </button>
          <span className="k-expanded-page__title">{title}</span>
        </header>
      )}
      {/* Keyed by page so switching pages fades the new body in over the
          panel that is already open, rather than replaying a close and an
          open. Opacity only; the panel itself does not move. */}
      <motion.div
        key={pageId}
        className={`${base}__body`}
        initial={switched ? { opacity: 0 } : false}
        animate={{ opacity: 1, transition: instant }}
      >
        {children}
      </motion.div>
    </div>
  );
});

export default PageShell;
