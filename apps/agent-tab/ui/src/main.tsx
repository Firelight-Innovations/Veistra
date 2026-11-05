import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { onThemeChanged } from "@veistra/bridge/theme";
// See apps/docs/ui/src/main.tsx for why these are root-relative imports
// rather than a copy of the palette.
import "/src/tokens.css";
import "/apps/shared/app.css";
// The agent tab's own tokens.
import "/src/agent-tokens.css";

// Follows the shell's live theme and accent (handoff §2.1.2).
onThemeChanged();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
