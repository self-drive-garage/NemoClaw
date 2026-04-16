// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const path = require("path");
const { spawnSync } = require("child_process");

const { ROOT, redact } = require("./runner");

function buildPythonPath(env = process.env) {
  const parts = [];
  if (ROOT) parts.push(ROOT);
  if (env.PYTHONPATH) parts.push(env.PYTHONPATH);
  return parts.filter(Boolean).join(path.delimiter);
}

async function runSlackActionItemsCommand(rawArgs, dependencies = {}) {
  const pythonBin =
    dependencies.pythonBin || process.env.PYTHON_BIN || process.env.PYTHON || "python3";
  const executor = dependencies.executor || spawnSync;
  const env = {
    ...process.env,
    ...dependencies.env,
    PYTHONPATH: buildPythonPath({ ...process.env, ...dependencies.env }),
  };

  const result = executor(
    pythonBin,
    ["-m", "nv_tools.commands.slack_action_items", ...rawArgs],
    {
      cwd: ROOT,
      env,
      encoding: "utf-8",
      stdio: dependencies.stdio || "inherit",
    },
  );

  if ((result.status ?? 0) !== 0) {
    const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
    throw new Error(
      output ? redact(output) : `slack-action-items failed with exit ${String(result.status ?? 1)}.`,
    );
  }

  return {
    code: 0,
    command: [pythonBin, "-m", "nv_tools.commands.slack_action_items", ...rawArgs],
  };
}

module.exports = {
  buildPythonPath,
  runSlackActionItemsCommand,
};
