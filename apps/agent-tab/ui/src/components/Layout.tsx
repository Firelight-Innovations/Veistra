import type { LayoutProps } from "./types";
import "./frame.css";

/**
 * The conversation in one column and, when it is open, the Details panel
 * beside it. A tab too narrow for both lays the panel over the conversation
 * (`frame.css`, by container width rather than window width, since a tab can
 * be a narrow pane in a wide window).
 */
export function Layout({ header, transcript, composer, details, overlay }: LayoutProps) {
  return (
    <div className="at" data-details={details ? "" : undefined}>
      <div className="at__main">
        {header}
        {transcript}
        {composer}
      </div>
      {details}
      {overlay}
    </div>
  );
}
