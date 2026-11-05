/**
 * The real agent on stdio with a scripted model in place of a provider, for the tests in
 * `test/` and in `crates/veistra-agent-host/tests/`. Everything but the model is the shipped
 * code: the ACP front end, the modes, the guard, the gate and Pi itself.
 *
 * `VEISTRA_AGENT_SCRIPT` names a JSON file: one entry per model request, each a list of blocks,
 * `{"text": ...}`, `{"thinking": ...}` or `{"tool": name, "args": {...}}`. An entry that is the
 * string `"echo"` answers with the last user message the model was sent, so a test can see what
 * reached it. The model is `scripted/scripted-1`; a test chooses it with `session/set_config_option`.
 */
import { readFileSync } from "node:fs";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { quietPi } from "../dist/node.js";
import { runStdio } from "../dist/stdio.js";

const script = JSON.parse(readFileSync(process.env.VEISTRA_AGENT_SCRIPT, "utf8"));
const faux = fauxProvider({
  provider: "scripted",
  models: [{ id: "scripted-1", name: "Scripted", reasoning: true }],
});
/** The text of the last user message in what the model was sent. */
function lastUser(context) {
  const user = [...context.messages].reverse().find((m) => m.role === "user");
  const content =
    typeof user?.content === "string"
      ? [{ type: "text", text: user.content }]
      : (user?.content ?? []);
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

faux.setResponses(
  script.map((blocks) => {
    if (blocks === "echo") return (context) => fauxAssistantMessage(fauxText(lastUser(context)));
    const content = blocks.map((b) => {
      if (b.tool) return fauxToolCall(b.tool, b.args ?? {});
      if (b.thinking) return fauxThinking(b.thinking);
      return fauxText(b.text ?? "");
    });
    const usesTools = blocks.some((b) => b.tool);
    return fauxAssistantMessage(content, { stopReason: usesTools ? "toolUse" : "stop" });
  }),
);
quietPi();
await runStdio((runtime) => runtime.registerNativeProvider(faux.provider));
