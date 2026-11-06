/**
 * A person's round mark: their picture when there is one, their initials when
 * there is not, and a generic person when nobody is signed in. One component,
 * so the title bar's account button and Settings' account header and Profile
 * row cannot draw three different circles for one account.
 *
 * `src` is the profile picture as `useAccount` holds it: a `data:` URL,
 * since an `<img>` cannot send the account's token itself.
 */
import { UserRound } from "lucide-react";
import "./ui.css";

export default function Avatar({
  initials,
  src = null,
  size = 22,
}: {
  /** Null draws the signed-out person glyph. */
  initials: string | null;
  src?: string | null;
  size?: number;
}) {
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (src !== null) {
    return <img className="k-avatar k-avatar--photo" src={src} alt="" style={style} />;
  }
  if (initials === null) {
    return (
      <span className="k-avatar k-avatar--empty" style={style} aria-hidden="true">
        <UserRound size={Math.round(size * 0.68)} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span className="k-avatar" style={style} aria-hidden="true">
      {initials}
    </span>
  );
}
