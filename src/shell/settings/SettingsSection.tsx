/**
 * One collapsible section of a settings page: a header button with a chevron,
 * and the rows under it.
 *
 * Which sections are folded is the screen's, through `SectionsContext`, so a
 * panel (Usage, Profile) can draw its own sections and still have them fold,
 * remember, open for a search and scroll into view for a deep link the way a
 * schema group's do.
 */
import { createContext, useContext, useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import Highlight from "./Highlight";

export interface SectionsState {
  /** Whether a section is unfolded. Every section is, while a search is up. */
  isOpen(id: string): boolean;
  toggle(id: string): void;
  /** The search, for highlighting. Empty while there is none. */
  needle: string;
  /** The section a deep link asked for, to scroll into view once it is drawn. */
  landing: string | null;
  /** Move the screen to another page or section, as a deep link would. */
  go?: (request: string) => void;
}

export const SectionsContext = createContext<SectionsState>({
  isOpen: () => true,
  toggle: () => {},
  needle: "",
  landing: null,
});

export function useSections(): SectionsState {
  return useContext(SectionsContext);
}

export default function SettingsSection({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  /** Drawn at the header's right, outside the toggle button (Reset section). */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const sections = useSections();
  const open = sections.isOpen(id);
  const bodyId = useId();
  const root = useRef<HTMLElement>(null);
  const landed = sections.landing === id;

  // A deep link's section is brought into view once, as it is first drawn.
  useEffect(() => {
    if (landed) root.current?.scrollIntoView?.({ block: "start" });
  }, [landed]);

  return (
    <section
      ref={root}
      className="settings-section"
      data-section={id}
      data-open={open || undefined}
      aria-label={title}
    >
      <div className="settings-section__head">
        <button
          type="button"
          className="settings-section__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => sections.toggle(id)}
        >
          <ChevronRight
            className="settings-section__chevron"
            size={14}
            strokeWidth={2}
            aria-hidden="true"
          />
          <span className="settings-section__text">
            <span className="settings-section__title">
              <Highlight text={title} needle={sections.needle} />
            </span>
            {description !== undefined && description !== "" && (
              <span className="settings-section__description">{description}</span>
            )}
          </span>
        </button>
        {actions !== undefined && <div className="settings-section__actions">{actions}</div>}
      </div>
      {open && (
        <div className="settings-section__body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}
