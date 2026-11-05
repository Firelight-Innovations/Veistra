import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { install } from "./agentBridge";
import { onThemeChanged } from "@veistra/bridge/theme";
// See apps/docs/ui/src/main.tsx for why these are root-relative imports
// rather than a copy of the palette.
import "/src/tokens.css";
import "/apps/shared/app.css";

// Follows the shell's live theme and accent — see
// `packages/bridge/src/theme.ts`. Called once, at module scope, so it is
// already listening by the time the bridge's `hello` handshake completes.
onThemeChanged();

// Rust reaches rendering and measuring through this; see `agentBridge.ts`.
install();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
