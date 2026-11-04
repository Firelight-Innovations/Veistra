import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@veistra/bridge", () => ({ invoke }));

import { logText, putLog, putShot } from "./context";
import type { LogLine } from "./rpc";

const line = (seq: number, level: LogLine["level"], text: string): LogLine => ({
  seq,
  stream: "stdout",
  level,
  text,
  at: 0,
});

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ id: "ctx-1" });
});

describe("logText", () => {
  it("spells the level out and keeps only the tail", () => {
    const lines = [line(0, "info", "boot"), line(1, "warning", "slow"), line(2, "error", "broke")];
    expect(logText(lines, "res://main.tscn", 2).split("\n")).toEqual([
      "Godot output for res://main.tscn (last 2 of 3 lines)",
      "[warning] slow",
      "[error] broke",
    ]);
  });
});

describe("context puts", () => {
  it("sends a captured frame as a panel with its bytes, named for scene and time", async () => {
    await putShot({ png: "QUJD", width: 4, height: 3, time: 12.4, scene: "res://a/main.tscn" });
    const [method, params] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(method).toBe("context/put");
    expect(params).toMatchObject({ kind: "panel", bytesBase64: "QUJD" });
    expect(params.title).toContain("res://a/main.tscn");
    expect(params.label).toContain("main.tscn");
    expect(params).not.toHaveProperty("path");
  });

  it("sends the log as text", async () => {
    await putLog([line(0, "error", "boom")], null);
    const [, params] = invoke.mock.calls[0] as [string, Record<string, unknown>];
    expect(params).toMatchObject({ kind: "text" });
    expect(params.text).toContain("[error] boom");
  });
});
