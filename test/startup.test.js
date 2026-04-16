// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  LAUNCH_AGENT_LABEL,
  SYSTEMD_SERVICE_NAME,
  buildLaunchAgentPlist,
  buildStartupScript,
  buildSystemdUnit,
  getStartupPaths,
  runStartupCommand,
} from "../bin/lib/startup";

describe("startup automation", () => {
  const cliPath = path.join(import.meta.dirname, "..", "bin", "nemoclaw.js");

  it("renders the startup launcher script with startup run", () => {
    const script = buildStartupScript({
      home: "/tmp/home",
      rootDir: "/repo",
      nodeBin: "/usr/bin/node",
      openshellBin: "/usr/local/bin/openshell",
      pathValue: "/usr/bin:/bin",
      withServices: true,
    });

    expect(script).toContain("startup run");
    expect(script).toContain("--with-services");
    expect(script).toContain("export HOME='/tmp/home'");
    expect(script).toContain("export PATH=");
    expect(script).toContain("export OPENSHELL_GATEWAY=nemoclaw");
    expect(script).toContain("cd '/repo'");
  });

  it("renders systemd and launchd definitions", () => {
    const unit = buildSystemdUnit({ scriptPath: "/tmp/home/.nemoclaw/startup/nemoclaw-startup.sh" });
    const plist = buildLaunchAgentPlist({
      scriptPath: "/tmp/home/.nemoclaw/startup/nemoclaw-startup.sh",
      logPath: "/tmp/home/.nemoclaw/startup/nemoclaw-startup.log",
    });

    expect(unit).toContain(`ExecStart=/tmp/home/.nemoclaw/startup/nemoclaw-startup.sh`);
    expect(unit).toContain(`WantedBy=default.target`);
    expect(SYSTEMD_SERVICE_NAME).toBe("nemoclaw-startup.service");
    expect(plist).toContain(LAUNCH_AGENT_LABEL);
    expect(plist).toContain("/tmp/home/.nemoclaw/startup/nemoclaw-startup.log");
  });

  it("enables a Linux startup service and writes the launcher files", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-startup-enable-"));
    const calls = [];
    const output = [];

    const result = await runStartupCommand(["enable", "--with-services"], {
      platform: "linux",
      home,
      rootDir: "/repo",
      nodeBin: "/usr/bin/node",
      openshellBin: "/usr/local/bin/openshell",
      pathValue: "/usr/bin:/bin",
      output: (line) => output.push(line),
      executor: (command, args) => {
        calls.push([command, ...args].join(" "));
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    const paths = getStartupPaths({ home });
    expect(result.code).toBe(0);
    expect(fs.existsSync(paths.scriptPath)).toBe(true);
    expect(fs.existsSync(paths.systemdUnitPath)).toBe(true);
    expect(fs.readFileSync(paths.scriptPath, "utf8")).toContain("--with-services");
    expect(fs.readFileSync(paths.systemdUnitPath, "utf8")).toContain(SYSTEMD_SERVICE_NAME);
    expect(calls).toContain(`systemctl --user daemon-reload`);
    expect(calls).toContain(`systemctl --user enable --now ${SYSTEMD_SERVICE_NAME}`);
    expect(output.join("\n")).toContain("Enabled NemoClaw startup recovery");
  });

  it("runs startup recovery against registered sandboxes", async () => {
    const output = [];
    const error = [];
    const commands = [];
    const healthyGatewayStatus = "Connected\nGateway: nemoclaw\n";
    const healthyNamedGatewayInfo = "Gateway: nemoclaw\nendpoint: https://127.0.0.1:8080\n";
    const healthyActiveGatewayInfo =
      "Gateway: nemoclaw\nGateway endpoint: https://127.0.0.1:8080\n";

    const result = await runStartupCommand(["run"], {
      openshellBin: "/usr/local/bin/openshell",
      output: (line) => output.push(line),
      error: (line) => error.push(line),
      listSandboxes: () => ({
        defaultSandbox: "alpha",
        sandboxes: [{ name: "alpha" }, { name: "beta" }],
      }),
      executor: (command, args) => {
        commands.push([command, ...args].join(" "));
        if (command === "/usr/local/bin/openshell" && args[0] === "status") {
          return { status: 0, stdout: healthyGatewayStatus, stderr: "" };
        }
        if (
          command === "/usr/local/bin/openshell" &&
          args[0] === "gateway" &&
          args[1] === "info" &&
          args[2] === "-g"
        ) {
          return { status: 0, stdout: healthyNamedGatewayInfo, stderr: "" };
        }
        if (
          command === "/usr/local/bin/openshell" &&
          args[0] === "gateway" &&
          args[1] === "info"
        ) {
          return { status: 0, stdout: healthyActiveGatewayInfo, stderr: "" };
        }
        if (command === "/usr/local/bin/openshell" && args[0] === "sandbox" && args[1] === "get") {
          if (args[2] === "beta") {
            return { status: 1, stdout: "", stderr: "beta missing" };
          }
          return { status: 0, stdout: "sandbox alpha", stderr: "" };
        }
        if (command === "/usr/local/bin/openshell" && args[0] === "sandbox" && args[1] === "ssh-config") {
          return { status: 0, stdout: "Host openshell-alpha\n", stderr: "" };
        }
        if (command === "ssh") {
          return { status: 0, stdout: "RUNNING", stderr: "" };
        }
        if (command === process.execPath && args[1] === "beta") {
          return { status: 0, stdout: "beta status reported success", stderr: "" };
        }
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });

    expect(result.code).toBe(0);
    expect(result.recovered).toBe(1);
    expect(result.failed).toBe(1);
    expect(commands).toContain("/usr/local/bin/openshell gateway start --name nemoclaw");
    expect(commands).toContain("/usr/local/bin/openshell sandbox get alpha");
    expect(commands).toContain("/usr/local/bin/openshell sandbox get beta");
    expect(commands).toContain(`${process.execPath} ${cliPath} beta status`);
    expect(commands).toContain("/usr/local/bin/openshell forward start --background 18789 alpha");
    expect(output.join("\n")).toContain("Startup recovery complete");
    expect(error.join("\n")).toContain("Failed to recover sandbox 'beta'");
    expect(error.join("\n")).toContain("beta missing");
  });

  it("fails startup recovery when the NemoClaw gateway never becomes healthy", async () => {
    const output = [];
    const error = [];

    await expect(
      runStartupCommand(["run"], {
        openshellBin: "/usr/local/bin/openshell",
        output: (line) => output.push(line),
        error: (line) => error.push(line),
        env: {
          NEMOCLAW_HEALTH_POLL_COUNT: "1",
          NEMOCLAW_HEALTH_POLL_INTERVAL: "1",
        },
        listSandboxes: () => ({
          defaultSandbox: "alpha",
          sandboxes: [{ name: "alpha" }],
        }),
        executor: (command, args) => {
          if (command === "/usr/local/bin/openshell" && args[0] === "status") {
            return { status: 1, stdout: "", stderr: "Connection refused" };
          }
          if (
            command === "/usr/local/bin/openshell" &&
            args[0] === "gateway" &&
            args[1] === "info" &&
            args[2] === "-g"
          ) {
            return { status: 0, stdout: "Gateway: nemoclaw\n", stderr: "" };
          }
          if (
            command === "/usr/local/bin/openshell" &&
            args[0] === "gateway" &&
            args[1] === "info"
          ) {
            return { status: 0, stdout: "Gateway endpoint: https://127.0.0.1:8080\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "Connection refused" };
        },
      }),
    ).rejects.toThrow("NemoClaw gateway is still unhealthy after startup recovery.");

    expect(output.join("\n")).toContain("Gateway startup output");
    expect(error.join("\n")).toContain("Gateway health check failed");
  });
});
