// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import path from "node:path";

import { buildPythonPath, runSlackActionItemsCommand } from "../bin/lib/slack-action-items";

describe("slack action items wrapper", () => {
  it("prepends the repo root to PYTHONPATH", () => {
    const root = path.join(import.meta.dirname, "..");
    const pythonPath = buildPythonPath({ PYTHONPATH: "/tmp/existing-pythonpath" });
    expect(pythonPath.startsWith(root)).toBe(true);
    expect(pythonPath.includes("/tmp/existing-pythonpath")).toBe(true);
  });

  it("delegates to the Python command module", async () => {
    const calls = [];
    const executor = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: "", stderr: "" };
    };

    const result = await runSlackActionItemsCommand(["--dry-run", "--days", "5"], {
      executor,
      stdio: "pipe",
      pythonBin: "python3",
    });

    expect(result.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("python3");
    expect(calls[0].args.slice(0, 2)).toEqual(["-m", "nv_tools.commands.slack_action_items"]);
    expect(calls[0].args.slice(2)).toEqual(["--dry-run", "--days", "5"]);
    expect(calls[0].options.cwd).toBe(path.join(import.meta.dirname, ".."));
    expect(calls[0].options.env.PYTHONPATH).toContain(path.join(import.meta.dirname, ".."));
  });
});
