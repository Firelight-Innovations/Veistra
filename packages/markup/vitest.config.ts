import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Vitest blanks every stylesheet unless asked. `stacking.test.ts` reads
    // these two as text to check the toolbar stacks above Excalidraw's canvas.
    css: { include: [/MarkupLayer\.css/, /@excalidraw[\\/]excalidraw[\\/].*index\.css/] },
  },
});
