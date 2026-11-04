import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { onThemeChanged } from "@veistra/bridge/theme";
// Root-relative, as every app imports them: the shell's own palette and the
// shared pane chrome, which carries the design system's `.k-*` classes.
import "/src/tokens.css";
import "/apps/shared/app.css";
import "./usage.css";

onThemeChanged();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
