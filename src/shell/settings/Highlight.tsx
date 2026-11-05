/** `text`, with each occurrence of the settings search marked. */
import { highlight } from "./pages";

export default function Highlight({ text, needle }: { text: string; needle: string }) {
  if (needle.trim() === "") return <>{text}</>;
  return (
    <>
      {highlight(text, needle).map((part, i) =>
        part.hit ? (
          <mark key={i} className="settings-mark">
            {part.text}
          </mark>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
