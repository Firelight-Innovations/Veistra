import { Info, TriangleAlert } from "lucide-react";
import { strings } from "../strings";
import type { NoticeItemProps } from "./types";
import "./details.css";

/** An advisory from the agent: a quiet line, in warning colours when it warns. */
export function NoticeItem({ severity, title, description }: NoticeItemProps) {
  const warning = severity === "warning";
  const Glyph = warning ? TriangleAlert : Info;
  return (
    <div className="at-item at-advisory" data-severity={warning ? "warning" : "info"}>
      <Glyph className="at-advisory__glyph" size={14} strokeWidth={2} aria-hidden="true" />
      <div className="at-advisory__body">
        <span className="at-sr">{strings.agentNotice[warning ? "warning" : "info"]}: </span>
        <span className="at-advisory__title">{title}</span>
        {description && <div className="at-advisory__text">{description}</div>}
      </div>
    </div>
  );
}
