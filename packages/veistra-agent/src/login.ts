/**
 * `veistra-agent login`: the harness's own sign-in, which saves a model provider's API key in the
 * agent's home through Pi's credential store (`auth.json`, written with mode 0600).
 *
 * In a terminal it asks there. With no terminal, which is how the agent tab's `/login` runs it, it
 * serves a one-page form on 127.0.0.1 under a random path, opens it in the browser, saves what is
 * submitted and exits: the same shape as `claude auth login`, which opens a browser and keeps its
 * own credentials. Veistra never sees the key.
 *
 * API keys only. Pi can also sign in to some providers with a subscription, and for Claude that is
 * the third-party route Anthropic's terms rule out (design §6), so no OAuth flow is offered here.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createInterface } from "node:readline/promises";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** The providers the browser form lists, first in the terminal too. Others: the terminal. */
export const COMMON = [
  "anthropic",
  "openai",
  "google",
  "openrouter",
  "xai",
  "mistral",
  "groq",
  "deepseek",
];

export interface ProviderChoice {
  id: string;
  name: string;
}

/** Every provider that takes an API key, the common ones first. */
export function providers(runtime: ModelRuntime): ProviderChoice[] {
  const all = runtime
    .getProviders()
    .filter((p) => p.auth.apiKey?.login)
    .map((p) => ({ id: p.id, name: p.name }));
  const rank = (id: string) => {
    const at = COMMON.indexOf(id);
    return at < 0 ? COMMON.length : at;
  };
  return all.sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** Save `key` for `providerId`, answering Pi's own key prompt with it. */
export async function saveKey(
  runtime: ModelRuntime,
  providerId: string,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("The key is empty.");
  await runtime.login(providerId, "api_key", {
    prompt: async (p) => {
      if (p.type === "secret" || p.type === "text") return trimmed;
      throw new Error(
        `${providerId} needs more than a key: run \`veistra-agent login\` in a terminal.`,
      );
    },
    notify: () => undefined,
  });
}

// --- in a terminal ----------------------------------------------------------------------

async function readSecret(question: string): Promise<string> {
  const input = process.stdin;
  process.stdout.write(question);
  if (!input.isTTY) {
    const rl = createInterface({ input });
    const line = await rl.question("");
    rl.close();
    return line;
  }
  input.setRawMode(true);
  input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (error?: Error) => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003") return done(new Error("Cancelled."));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    input.on("data", onData);
  });
}

export async function terminalLogin(runtime: ModelRuntime, wanted?: string): Promise<string> {
  const list = providers(runtime);
  let id = wanted;
  if (!id) {
    list.forEach((p, i) => process.stdout.write(`${String(i + 1).padStart(3)}. ${p.name}\n`));
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Provider (number or id): ");
    rl.close();
    const n = Number(answer.trim());
    id = Number.isInteger(n) && n >= 1 && n <= list.length ? list[n - 1]!.id : answer.trim();
  }
  const provider = list.find((p) => p.id === id);
  if (!provider) throw new Error(`No provider ${id} takes an API key.`);
  await runtime.login(provider.id, "api_key", {
    prompt: async (p) => {
      if (p.type === "secret") return readSecret(`${p.message}: `);
      if (p.type === "select") {
        p.options.forEach((o, i) =>
          process.stdout.write(`${String(i + 1).padStart(3)}. ${o.label}\n`),
        );
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const pick = Number((await rl.question(`${p.message}: `)).trim());
        rl.close();
        const option = p.options[pick - 1];
        if (!option) throw new Error("No such option.");
        return option.id;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const line = await rl.question(`${p.message}: `);
      rl.close();
      return line;
    },
    notify: (event) => {
      if (event.type === "info" || event.type === "progress")
        process.stdout.write(`${event.message}\n`);
    },
  });
  return provider.name;
}

// --- in the browser ---------------------------------------------------------------------

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function page(choices: ProviderChoice[], message = ""): string {
  const options = choices
    .map((p) => `<option value="${escape(p.id)}">${escape(p.name)}</option>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in to Veistra's agent</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1d1d1f}label{display:block;margin:1rem 0 .25rem;font-weight:600}select,input{width:100%;box-sizing:border-box;padding:.5rem;font:inherit}button{margin-top:1.25rem;padding:.5rem 1.25rem;font:inherit}p.note{color:#666;font-size:13px}p.error{color:#b00020}</style></head>
<body><h1>Veistra's agent</h1><p>Choose a model provider and paste your API key. It is saved on this computer for Veistra's agent only.</p>
${message ? `<p class="error">${escape(message)}</p>` : ""}
<form method="post"><label for="provider">Provider</label><select id="provider" name="provider">${options}</select>
<label for="key">API key</label><input id="key" name="key" type="password" autocomplete="off" required autofocus>
<button type="submit">Save</button></form>
<p class="note">Another provider, or one that needs more than a key: run <code>veistra-agent login</code> in a terminal.</p></body></html>`;
}

const DONE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Signed in</title></head><body style="font:15px system-ui,sans-serif;max-width:32rem;margin:4rem auto"><h1>Saved</h1><p>Veistra's agent can use this provider now. You can close this tab.</p></body></html>`;

function readBody(req: IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error("too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore" })
      .on("error", () => undefined)
      .unref();
  } catch {
    // The URL is printed too; a person can open it by hand.
  }
}

export interface BrowserLogin {
  /** The page's address, with its one-time path. */
  url: string;
  /** Settles with the provider's name once a key is saved, or rejects on timeout. */
  done: Promise<string>;
  close: () => void;
}

/** Serve the form on 127.0.0.1 until a key is saved or `timeoutMs` passes. */
export async function browserLogin(
  runtime: ModelRuntime,
  timeoutMs = 10 * 60_000,
): Promise<BrowserLogin> {
  const choices = providers(runtime).filter((p) => COMMON.includes(p.id));
  const token = randomBytes(24).toString("hex");
  let settle: (name: string) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const done = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer(async (req, res) => {
    const host = req.headers.host ?? "";
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // A page elsewhere cannot know the path, and a rebound name cannot pass this check.
    if (host !== `127.0.0.1:${port}` || req.url !== `/${token}`) {
      res.writeHead(404).end();
      return;
    }
    const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
    if (req.method === "GET") {
      res.writeHead(200, headers).end(page(choices));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    try {
      const form = new URLSearchParams(await readBody(req));
      const id = form.get("provider") ?? "";
      const choice = choices.find((p) => p.id === id);
      if (!choice) throw new Error("Choose a provider.");
      await saveKey(runtime, choice.id, form.get("key") ?? "");
      res.writeHead(200, headers).end(DONE);
      settle(choice.name);
    } catch (e) {
      res.writeHead(400, headers).end(page(choices, e instanceof Error ? e.message : String(e)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const timer = setTimeout(() => fail(new Error("Timed out waiting for the key.")), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  void done.then(close, close);
  return { url: `http://127.0.0.1:${port}/${token}`, done, close };
}
