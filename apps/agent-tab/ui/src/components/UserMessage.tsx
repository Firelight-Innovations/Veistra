import { useContext, type KeyboardEvent } from "react";
import { strings } from "../strings";
import { useSlots } from "./registry";
import type { UserMessageProps } from "./types";
import { referenceKind, referenceParts } from "../mentions";
import { ChipOpen } from "../chipOpen";
import "./items.css";
import "./composer-effects.css";
import "./kinds.css";

export function UserMessage({ text, pending = false }: UserMessageProps) {
  const S = useSlots();
  const opener = useContext(ChipOpen);
  return (
    <div className={pending ? "at-item at-user at-user--pending" : "at-item at-user"}>
      <div className="at-sr">{strings.you}</div>
      <div className="at-user__text">
        {referenceParts(text).map((part, i) => {
          if (!part.uri) return <span key={i}>{part.text}</span>;
          const uri = part.uri;
          // A chip naming something an editor shows is a button that shows it there.
          const opens = opener?.opens(uri) ?? false;
          const press = (e: KeyboardEvent) => {
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            opener?.open(uri);
          };
          return (
            <span
              key={i}
              className="at-chip at-chip--reference"
              title={opens ? `${strings.showInEditor} · ${uri}` : uri}
              // The same colour the chip had in the prompt, read back from where it points.
              data-kind={referenceKind(uri) ?? undefined}
              {...(opens
                ? {
                    role: "button",
                    tabIndex: 0,
                    "data-opens": "",
                    onClick: () => opener?.open(uri),
                    onKeyDown: press,
                  }
                : {})}
            >
              @{part.text}
            </span>
          );
        })}
      </div>
      {pending && <S.Note text={strings.starting} />}
    </div>
  );
}
