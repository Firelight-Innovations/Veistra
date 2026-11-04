/**
 * The shell's theme as the page sees it (`data-theme` on the root element),
 * kept current, for the markup layer's ink and chrome.
 */
import { useEffect, useState } from "react";

export function useTheme(): "dark" | "light" {
  const read = () => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
  const [theme, setTheme] = useState<"dark" | "light">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}
