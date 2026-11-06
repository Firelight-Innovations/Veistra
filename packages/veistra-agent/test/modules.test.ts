/**
 * The modules one at a time: the guard, the mode policy, prompt conversion, the MCP mapping and
 * the browser sign-in.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { climbs, expand, Worktree } from "../src/guard.js";
import { browserLogin, providers } from "../src/login.js";
import { entries } from "../src/mcp.js";
import { ACCEPT_EDITS, ASK_FIRST, classify, decide, PLAN } from "../src/modes.js";
import { checkNode } from "../src/node.js";
import { toPi } from "../src/prompt.js";
import { isAuthError } from "../src/session.js";
import { diffOf, mcpOrigin } from "../src/tools.js";
import { scratch } from "./client.js";

describe("the guard", () => {
  it("keeps paths inside the worktree and rewrites them absolute", () => {
    const root = scratch();
    const tree = new Worktree(root);
    const input: Record<string, unknown> = { path: "src/new.ts" };
    expect(tree.check("write", input)).toBeNull();
    expect(input.path).toBe(path.join(root, "src", "new.ts"));
    expect(tree.check("ls", {})).toBeNull();
    expect(tree.resolve("..hidden")).toBe(path.join(root, "..hidden"));
  });

  it("refuses a climb, an absolute path elsewhere, a home path and a symlink out", () => {
    const root = scratch();
    const outside = scratch();
    symlinkSync(outside, path.join(root, "link"), "junction");
    const tree = new Worktree(root);
    for (const p of ["../x", path.join(outside, "f"), "~/x", "link/f", "@../x"]) {
      expect(tree.check("read", { path: p }), p).not.toBeNull();
    }
    expect(tree.check("read", { path: 3 })).not.toBeNull();
    expect(tree.check("bash", { command: "cat ../x" })).toBeNull();
  });

  it("refuses a find pattern that climbs out", () => {
    expect(climbs("../**")).toBe(true);
    expect(climbs("/etc/*")).toBe(true);
    expect(climbs("C:/x")).toBe(true);
    expect(climbs("src/**/*.ts")).toBe(false);
    expect(new Worktree(scratch()).check("find", { pattern: "a/../../*" })).not.toBeNull();
  });

  it("reads paths the way Pi does", () => {
    expect(expand("@src/a.ts", "/home/u", "linux")).toBe("src/a.ts");
    expect(expand("~/a", "/home/u", "linux")).toBe(path.join("/home/u", "a"));
    expect(expand("/c/game", "C:\\Users\\u", "win32")).toBe("C:\\game");
  });
});

describe("the modes", () => {
  it("ask first, accept edits only in the worktree, and plan without edits", () => {
    expect(decide(ASK_FIRST, classify("read"))).toBe("run");
    expect(decide(ASK_FIRST, classify("edit"))).toBe("ask");
    expect(decide(ASK_FIRST, classify("bash"))).toBe("ask");
    expect(decide(ASK_FIRST, classify("mcp__veistra_context__show"))).toBe("ask");
    expect(decide(ACCEPT_EDITS, classify("write"))).toBe("run");
    expect(decide(ACCEPT_EDITS, classify("bash"))).toBe("ask");
    expect(decide(PLAN, classify("write"))).toBe("refuse");
    expect(decide(PLAN, classify("grep"))).toBe("run");
    expect(decide(PLAN, classify("powershell"))).toBe("ask");
  });
});

describe("prompts", () => {
  it("keeps text in order, inlines resources, and passes pictures as images", () => {
    const pi = toPi([
      { type: "text", text: "hidden context" },
      { type: "text", text: "the question" },
      { type: "resource_link", uri: "file:///w/a.ts", name: "a.ts" },
      { type: "resource", resource: { uri: "veistra://x", text: "body" } },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ]);
    expect(pi.text).toBe(
      'hidden context\n\nthe question\n\n[a.ts](file:///w/a.ts)\n\n<context uri="veistra://x">\nbody\n</context>',
    );
    expect(pi.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
  });
});

describe("Veistra's MCP servers", () => {
  it("become direct HTTP servers with their bearer, and odd values are dropped", () => {
    const list = entries([
      {
        type: "http",
        name: "veistra-context",
        url: "http://127.0.0.1:9/mcp",
        headers: [{ name: "Authorization", value: "Bearer abc" }],
      },
      { type: "http", name: "bad", url: "http://x", headers: [{ name: "A", value: "${HOME}" }] },
      { name: "cmd", command: "node", args: ["s.js"], env: [{ name: "X", value: "!rm" }] },
      { name: "nothing" },
    ]);
    expect(list).toEqual([
      {
        name: "veistra-context",
        config: {
          type: "http",
          url: "http://127.0.0.1:9/mcp",
          headers: { Authorization: "Bearer abc" },
          exposure: "direct",
        },
        source: "veistra",
        scope: "extension",
      },
    ]);
    expect(mcpOrigin("mcp__veistra_context__show", ["veistra-context"])).toEqual({
      server: "veistra-context",
      tool: "show",
    });
    expect(mcpOrigin("mcp__other__show", ["veistra-context"])).toBeNull();
  });
});

describe("diffs and errors", () => {
  it("previews an edit against the file as it is", () => {
    const root = scratch();
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src", "a.ts"), "let a = 1;\n");
    const edit = { path: "src/a.ts", edits: [{ oldText: "1", newText: "2" }] };
    expect(diffOf(root, "edit", edit)).toMatchObject({
      oldText: "let a = 1;\n",
      newText: "let a = 2;\n",
    });
    expect(
      diffOf(root, "edit", { path: "src/a.ts", edits: [{ oldText: "z", newText: "y" }] }),
    ).toBeNull();
    expect(diffOf(root, "read", { path: "src/a.ts" })).toBeNull();
  });

  it("tells a sign-in problem from any other failure", () => {
    expect(isAuthError("No API key found for anthropic")).toBe(true);
    expect(isAuthError("401 Unauthorized")).toBe(true);
    expect(isAuthError("rate limited, retry later")).toBe(false);
    expect(checkNode("22.18.0")).not.toBeNull();
    expect(checkNode("22.19.0")).toBeNull();
    expect(checkNode("24.1.0")).toBeNull();
  });
});

function post(url: string, body: string, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          ...(host ? { host } : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

describe("browser sign-in", () => {
  it("saves a key posted to its one-time path, and nothing posted anywhere else", async () => {
    const home = scratch();
    const runtime = await ModelRuntime.create({
      authPath: path.join(home, "auth.json"),
      modelsPath: path.join(home, "models.json"),
    });
    expect(providers(runtime)[0]!.id).toBe("anthropic");
    const served = await browserLogin(runtime, 10_000);
    const url = new URL(served.url);
    expect(await post(`${url.origin}/wrong`, "provider=anthropic&key=k")).toBe(404);
    expect(await post(served.url, "provider=anthropic&key=k", "evil.example:80")).toBe(404);
    expect(await post(served.url, "provider=nope&key=k")).toBe(400);
    expect(await post(served.url, "provider=anthropic&key=sk-test")).toBe(200);
    await expect(served.done).resolves.toBe("Anthropic");
    expect(await runtime.listCredentials()).toEqual([{ providerId: "anthropic", type: "api_key" }]);
  });
});
