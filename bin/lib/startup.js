// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const { ROOT, shellQuote } = require("./runner");
const { isGatewayHealthy } = require("./onboard");
const { resolveOpenshell } = require("./resolve-openshell");
const registry = require("./registry");

const SYSTEMD_SERVICE_NAME = "nemoclaw-startup.service";
const LAUNCH_AGENT_LABEL = "ai.nemoclaw.startup";
const DASHBOARD_FORWARD_PORT = "18789";
const GATEWAY_NAME = "nemoclaw";

function getHomeDir(home = process.env.HOME || os.homedir() || "/tmp") {
  return path.resolve(home);
}

function getStartupPaths(opts = {}) {
  const home = getHomeDir(opts.home);
  const startupDir = path.join(home, ".nemoclaw", "startup");
  return {
    home,
    startupDir,
    scriptPath: path.join(startupDir, "nemoclaw-startup.sh"),
    logPath: path.join(startupDir, "nemoclaw-startup.log"),
    systemdDir: path.join(home, ".config", "systemd", "user"),
    systemdUnitPath: path.join(home, ".config", "systemd", "user", SYSTEMD_SERVICE_NAME),
    launchAgentsDir: path.join(home, "Library", "LaunchAgents"),
    launchAgentPath: path.join(home, "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
  };
}

function dedupePaths(entries) {
  const seen = new Set();
  const ordered = [];
  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    ordered.push(entry);
  }
  return ordered;
}

function buildStartupScript(opts = {}) {
  const home = getHomeDir(opts.home);
  const rootDir = opts.rootDir || ROOT;
  const nodeBin = opts.nodeBin || process.execPath;
  const openshellBin = opts.openshellBin || resolveOpenshell({ home });
  const cliPath = opts.cliPath || path.join(rootDir, "bin", "nemoclaw.js");
  const pathValue = opts.pathValue || process.env.PATH || "";
  const args = [cliPath, "startup", "run"];
  if (opts.withServices) args.push("--with-services");
  const pathEntries = dedupePaths([
    path.dirname(nodeBin),
    openshellBin ? path.dirname(openshellBin) : null,
    ...String(pathValue)
      .split(path.delimiter)
      .filter(Boolean),
  ]);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `export HOME=${shellQuote(home)}`,
    `export PATH=${shellQuote(pathEntries.join(path.delimiter))}`,
    "export OPENSHELL_GATEWAY=nemoclaw",
    `cd ${shellQuote(rootDir)}`,
    `exec ${shellQuote(nodeBin)} ${args.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

function buildSystemdUnit(opts = {}) {
  const scriptPath = opts.scriptPath;
  return [
    "[Unit]",
    "Description=Recover NemoClaw gateway and sandboxes on login",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${scriptPath}`,
    "Restart=on-failure",
    "RestartSec=15",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildLaunchAgentPlist(opts = {}) {
  const scriptPath = opts.scriptPath;
  const logPath = opts.logPath;
  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(LAUNCH_AGENT_LABEL)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${escapeXml(scriptPath)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapeXml(logPath)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function getPlatformManager(platform = process.platform) {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd-user";
  throw new Error(`Startup automation is not supported on platform '${platform}'.`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

function writeRegularFile(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o644 });
  fs.chmodSync(filePath, 0o644);
}

function runCommand(executor, command, args, opts = {}) {
  return executor(command, args, {
    cwd: opts.cwd || ROOT,
    env: opts.env || process.env,
    encoding: "utf-8",
    stdio: opts.stdio || ["ignore", "pipe", "pipe"],
  });
}

function resultOutput(result) {
  return `${result.stdout || ""}${result.stderr || ""}`.trim();
}

function captureCommand(executor, command, args, opts = {}) {
  const result = runCommand(executor, command, args, {
    ...opts,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    output: resultOutput(result),
  };
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepSeconds(executor, seconds, env) {
  executor("sleep", [String(seconds)], {
    cwd: ROOT,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "ignore", "ignore"],
  });
}

function compactOutput(value, maxLength = 240) {
  const compact = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

function getGatewayHealthState(openshellBin, env, executor = spawnSync) {
  const status = captureCommand(executor, openshellBin, ["status"], { env });
  const namedInfo = captureCommand(executor, openshellBin, ["gateway", "info", "-g", GATEWAY_NAME], {
    env,
  });
  const activeInfo = captureCommand(executor, openshellBin, ["gateway", "info"], { env });
  return {
    status: status.output,
    namedInfo: namedInfo.output,
    activeInfo: activeInfo.output,
    healthy: isGatewayHealthy(status.output, namedInfo.output, activeInfo.output),
  };
}

function ensureGatewayHealthy(openshellBin, env, executor = spawnSync, output = console.log, error = console.error) {
  const initialState = getGatewayHealthState(openshellBin, env, executor);
  if (initialState.healthy) return true;

  const startResult = captureCommand(executor, openshellBin, ["gateway", "start", "--name", GATEWAY_NAME], {
    env,
  });
  const startSummary = compactOutput(startResult.output);
  if (startSummary) {
    output(`  Gateway startup output: ${startSummary}`);
  }

  const pollCount = parsePositiveInt(
    env.NEMOCLAW_HEALTH_POLL_COUNT || process.env.NEMOCLAW_HEALTH_POLL_COUNT,
    5,
  );
  const pollInterval = parsePositiveInt(
    env.NEMOCLAW_HEALTH_POLL_INTERVAL || process.env.NEMOCLAW_HEALTH_POLL_INTERVAL,
    2,
  );

  let latestState = initialState;
  for (let attempt = 0; attempt < pollCount; attempt += 1) {
    latestState = getGatewayHealthState(openshellBin, env, executor);
    if (latestState.healthy) {
      return true;
    }
    if (attempt < pollCount - 1) {
      sleepSeconds(executor, pollInterval, env);
    }
  }

  const diagnostic = compactOutput(
    latestState.status || latestState.namedInfo || latestState.activeInfo || startResult.output,
  );
  if (diagnostic) {
    error(`  Gateway health check failed: ${diagnostic}`);
  }
  return false;
}

function executeSandboxCommand(openshellBin, sandboxName, command, env, executor = spawnSync) {
  const sshConfigResult = runCommand(
    executor,
    openshellBin,
    ["sandbox", "ssh-config", sandboxName],
    { env },
  );
  if (sshConfigResult.status !== 0) return null;

  const tmpFile = path.join(os.tmpdir(), `nemoclaw-startup-ssh-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, sshConfigResult.stdout || "", { mode: 0o600 });
  try {
    const result = executor(
      "ssh",
      [
        "-F",
        tmpFile,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        `openshell-${sandboxName}`,
        command,
      ],
      {
        cwd: ROOT,
        env,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

function isSandboxGatewayRunning(openshellBin, sandboxName, env, executor = spawnSync) {
  const result = executeSandboxCommand(
    openshellBin,
    sandboxName,
    "curl -sf --max-time 3 http://127.0.0.1:18789/ > /dev/null 2>&1 && echo RUNNING || echo STOPPED",
    env,
    executor,
  );
  if (!result) return null;
  if (result.stdout === "RUNNING") return true;
  if (result.stdout === "STOPPED") return false;
  return null;
}

function recoverSandboxProcesses(openshellBin, sandboxName, env, executor = spawnSync) {
  const script = [
    "[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null;",
    "if curl -sf --max-time 3 http://127.0.0.1:18789/ > /dev/null 2>&1; then echo ALREADY_RUNNING; exit 0; fi;",
    "rm -rf /tmp/openclaw-*/gateway.*.lock 2>/dev/null;",
    "rm -f /tmp/gateway.log /tmp/auto-pair.log;",
    "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
    "touch /tmp/auto-pair.log; chmod 600 /tmp/auto-pair.log;",
    'OPENCLAW="$(command -v openclaw)";',
    'if [ -z "$OPENCLAW" ]; then echo OPENCLAW_MISSING; exit 1; fi;',
    'nohup "$OPENCLAW" gateway run > /tmp/gateway.log 2>&1 &',
    "GPID=$!; sleep 2;",
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; cat /tmp/gateway.log 2>/dev/null | tail -5; fi',
  ].join(" ");
  const result = executeSandboxCommand(openshellBin, sandboxName, script, env, executor);
  if (!result) return false;
  return (
    result.status === 0 &&
    (result.stdout.includes("GATEWAY_PID=") || result.stdout.includes("ALREADY_RUNNING"))
  );
}

function attemptStatusRecovery(nodeBin, cliPath, sandboxName, env, executor, output) {
  const result = runCommand(executor, nodeBin, [cliPath, sandboxName, "status"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const statusOutput = resultOutput(result);
  if (statusOutput) {
    output(statusOutput);
  }
  return {
    ok: result.status === 0,
    output: statusOutput,
  };
}

function verifySandboxReady(openshellBin, sandboxName, env, executor = spawnSync) {
  const lookup = captureCommand(executor, openshellBin, ["sandbox", "get", sandboxName], { env });
  if (lookup.status !== 0) {
    return {
      ready: false,
      reason: lookup.output || `Sandbox '${sandboxName}' is not reachable through the NemoClaw gateway.`,
    };
  }

  let running = isSandboxGatewayRunning(openshellBin, sandboxName, env, executor);
  if (running === true) {
    return { ready: true, recoveredProcess: false, reason: "" };
  }

  if (running === false) {
    const recoveredProcess = recoverSandboxProcesses(openshellBin, sandboxName, env, executor);
    if (recoveredProcess) {
      sleepSeconds(executor, 3, env);
      running = isSandboxGatewayRunning(openshellBin, sandboxName, env, executor);
      if (running === true) {
        return { ready: true, recoveredProcess: true, reason: "" };
      }
    }
    return {
      ready: false,
      reason: `OpenClaw is not responding inside sandbox '${sandboxName}'.`,
    };
  }

  return {
    ready: false,
    reason: `Could not inspect the OpenClaw gateway state inside sandbox '${sandboxName}'.`,
  };
}

function recoverViaStatusAndVerify(
  nodeBin,
  cliPath,
  openshellBin,
  sandboxName,
  env,
  executor,
  output,
) {
  const statusAttempt = attemptStatusRecovery(nodeBin, cliPath, sandboxName, env, executor, output);
  const verification = verifySandboxReady(openshellBin, sandboxName, env, executor);
  return {
    ready: verification.ready,
    recoveredProcess: verification.recoveredProcess === true,
    statusAttempt,
    verification,
  };
}

function enableStartupManager(manager, paths, deps = {}) {
  const executor = deps.executor || spawnSync;
  if (manager === "systemd-user") {
    const daemonReload = runCommand(executor, "systemctl", ["--user", "daemon-reload"], deps);
    if (daemonReload.status !== 0) {
      throw new Error(`systemctl --user daemon-reload failed: ${resultOutput(daemonReload)}`);
    }
    const enable = runCommand(
      executor,
      "systemctl",
      ["--user", "enable", "--now", SYSTEMD_SERVICE_NAME],
      deps,
    );
    if (enable.status !== 0) {
      throw new Error(`systemctl --user enable --now failed: ${resultOutput(enable)}`);
    }
    return;
  }

  const unload = runCommand(
    executor,
    "launchctl",
    ["unload", "-w", paths.launchAgentPath],
    { ...deps, stdio: ["ignore", "ignore", "ignore"] },
  );
  void unload;
  const load = runCommand(executor, "launchctl", ["load", "-w", paths.launchAgentPath], deps);
  if (load.status !== 0) {
    throw new Error(`launchctl load -w failed: ${resultOutput(load)}`);
  }
}

function disableStartupManager(manager, paths, deps = {}) {
  const executor = deps.executor || spawnSync;
  if (manager === "systemd-user") {
    runCommand(
      executor,
      "systemctl",
      ["--user", "disable", "--now", SYSTEMD_SERVICE_NAME],
      { ...deps, stdio: ["ignore", "ignore", "ignore"] },
    );
    runCommand(
      executor,
      "systemctl",
      ["--user", "daemon-reload"],
      { ...deps, stdio: ["ignore", "ignore", "ignore"] },
    );
    return;
  }
  runCommand(
    executor,
    "launchctl",
    ["unload", "-w", paths.launchAgentPath],
    { ...deps, stdio: ["ignore", "ignore", "ignore"] },
  );
}

function getManagerEnabledState(manager, paths, deps = {}) {
  const executor = deps.executor || spawnSync;
  if (manager === "systemd-user") {
    const result = runCommand(
      executor,
      "systemctl",
      ["--user", "is-enabled", SYSTEMD_SERVICE_NAME],
      { ...deps, stdio: ["ignore", "pipe", "pipe"] },
    );
    if (result.status === 0) return "enabled";
    const output = resultOutput(result);
    if (/disabled|not-found/i.test(output)) return "disabled";
    return "unknown";
  }

  const result = runCommand(
    executor,
    "launchctl",
    ["list", LAUNCH_AGENT_LABEL],
    { ...deps, stdio: ["ignore", "pipe", "pipe"] },
  );
  return result.status === 0 ? "enabled" : "disabled";
}

function installStartup(opts = {}, deps = {}) {
  const manager = getPlatformManager(opts.platform);
  const paths = getStartupPaths({ home: opts.home });
  const openshellBin = opts.openshellBin || resolveOpenshell({ home: paths.home });
  if (!openshellBin) {
    throw new Error("openshell CLI not found. Install OpenShell before enabling startup recovery.");
  }

  ensureDir(paths.startupDir);
  if (manager === "systemd-user") ensureDir(paths.systemdDir);
  else ensureDir(paths.launchAgentsDir);

  writeExecutable(
    paths.scriptPath,
    buildStartupScript({
      home: paths.home,
      rootDir: opts.rootDir || ROOT,
      nodeBin: opts.nodeBin || process.execPath,
      openshellBin,
      cliPath: opts.cliPath,
      pathValue: opts.pathValue,
      withServices: opts.withServices === true,
    }),
  );

  if (manager === "systemd-user") {
    writeRegularFile(paths.systemdUnitPath, buildSystemdUnit({ scriptPath: paths.scriptPath }));
  } else {
    writeRegularFile(
      paths.launchAgentPath,
      buildLaunchAgentPlist({ scriptPath: paths.scriptPath, logPath: paths.logPath }),
    );
  }

  enableStartupManager(manager, paths, deps);
  return { manager, paths };
}

function uninstallStartup(opts = {}, deps = {}) {
  const manager = getPlatformManager(opts.platform);
  const paths = getStartupPaths({ home: opts.home });
  disableStartupManager(manager, paths, deps);
  for (const target of [
    paths.scriptPath,
    manager === "systemd-user" ? paths.systemdUnitPath : paths.launchAgentPath,
  ]) {
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }
  return { manager, paths };
}

function getStartupStatus(opts = {}, deps = {}) {
  const manager = getPlatformManager(opts.platform);
  const paths = getStartupPaths({ home: opts.home });
  const installed =
    fs.existsSync(paths.scriptPath) &&
    fs.existsSync(manager === "systemd-user" ? paths.systemdUnitPath : paths.launchAgentPath);
  const enabled = installed ? getManagerEnabledState(manager, paths, deps) : "disabled";
  return { manager, paths, installed, enabled };
}

async function runStartupRecovery(opts = {}, deps = {}) {
  const output = deps.output || console.log;
  const error = deps.error || console.error;
  const executor = deps.executor || spawnSync;
  const nodeBin = deps.nodeBin || process.execPath;
  const cliPath = deps.cliPath || path.join(ROOT, "bin", "nemoclaw.js");
  const openshellBin = deps.openshellBin || resolveOpenshell();
  if (!openshellBin) {
    throw new Error("openshell CLI not found. Install OpenShell before running startup recovery.");
  }

  const listed = (deps.listSandboxes || registry.listSandboxes)();
  const recoveryEnv = {
    ...process.env,
    ...deps.env,
    OPENSHELL_GATEWAY: "nemoclaw",
  };
  const sandboxes = Array.isArray(listed.sandboxes) ? listed.sandboxes : [];
  const defaultSandbox =
    listed.defaultSandbox ||
    (sandboxes.length > 0 && sandboxes[0] && sandboxes[0].name ? sandboxes[0].name : null);

  if (sandboxes.length === 0) {
    output("");
    output("  No registered sandboxes. Startup recovery has nothing to do.");
    output("");
    return { recovered: 0, failed: 0, defaultSandbox: null };
  }

  if (!ensureGatewayHealthy(openshellBin, recoveryEnv, executor, output, error)) {
    throw new Error("NemoClaw gateway is still unhealthy after startup recovery.");
  }

  let recovered = 0;
  let failed = 0;
  const readyNames = [];
  for (const sandbox of sandboxes) {
    const name = sandbox && sandbox.name;
    if (!name) continue;
    output(`  Recovering sandbox '${name}'...`);
    const lookup = runCommand(executor, openshellBin, ["sandbox", "get", name], {
      env: recoveryEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (lookup.status !== 0) {
      const lookupOutput = resultOutput(lookup);
      if (lookupOutput) {
        error(lookupOutput);
      }
      const fallback = recoverViaStatusAndVerify(
        nodeBin,
        cliPath,
        openshellBin,
        name,
        recoveryEnv,
        executor,
        output,
      );
      if (!fallback.ready) {
        error(`  Failed to recover sandbox '${name}'.`);
        if (fallback.verification.reason) {
          error(`  ${fallback.verification.reason}`);
        }
        failed += 1;
        continue;
      }
      if (fallback.recoveredProcess) {
        output(`  Restarted the OpenClaw gateway inside sandbox '${name}'.`);
      }
      recovered += 1;
      readyNames.push(name);
      continue;
    }

    const running = isSandboxGatewayRunning(openshellBin, name, recoveryEnv, executor);
    if (running === false) {
      const recoveredProcess = recoverSandboxProcesses(openshellBin, name, recoveryEnv, executor);
      if (!recoveredProcess) {
        const fallback = recoverViaStatusAndVerify(
          nodeBin,
          cliPath,
          openshellBin,
          name,
          recoveryEnv,
          executor,
          output,
        );
        if (!fallback.ready) {
          error(`  Failed to restart the OpenClaw gateway inside sandbox '${name}'.`);
          if (fallback.verification.reason) {
            error(`  ${fallback.verification.reason}`);
          }
          failed += 1;
          continue;
        }
        if (fallback.recoveredProcess) {
          output(`  Restarted the OpenClaw gateway inside sandbox '${name}'.`);
        }
        recovered += 1;
        readyNames.push(name);
        continue;
      }
      sleepSeconds(executor, 3, recoveryEnv);
      if (isSandboxGatewayRunning(openshellBin, name, recoveryEnv, executor) !== true) {
        const fallback = recoverViaStatusAndVerify(
          nodeBin,
          cliPath,
          openshellBin,
          name,
          recoveryEnv,
          executor,
          output,
        );
        if (!fallback.ready) {
          error(`  Sandbox '${name}' is reachable, but the OpenClaw gateway is still not responding.`);
          if (fallback.verification.reason) {
            error(`  ${fallback.verification.reason}`);
          }
          failed += 1;
          continue;
        }
        if (fallback.recoveredProcess) {
          output(`  Restarted the OpenClaw gateway inside sandbox '${name}'.`);
        }
        recovered += 1;
        readyNames.push(name);
        continue;
      }
      output(`  Restarted the OpenClaw gateway inside sandbox '${name}'.`);
    } else if (running === null) {
      const fallback = recoverViaStatusAndVerify(
        nodeBin,
        cliPath,
        openshellBin,
        name,
        recoveryEnv,
        executor,
        output,
      );
      if (!fallback.ready) {
        error(`  Could not inspect the OpenClaw gateway state inside sandbox '${name}'.`);
        if (fallback.verification.reason) {
          error(`  ${fallback.verification.reason}`);
        }
        failed += 1;
        continue;
      }
      if (fallback.recoveredProcess) {
        output(`  Restarted the OpenClaw gateway inside sandbox '${name}'.`);
      }
      recovered += 1;
      readyNames.push(name);
      continue;
    } else {
      output(`  Sandbox '${name}' is running.`);
    }
    recovered += 1;
    readyNames.push(name);
  }

  const targetForwardSandbox =
    defaultSandbox && readyNames.includes(defaultSandbox) ? defaultSandbox : readyNames[0] || null;
  if (targetForwardSandbox) {
    runCommand(executor, openshellBin, ["forward", "stop", DASHBOARD_FORWARD_PORT], {
      env: recoveryEnv,
      stdio: ["ignore", "ignore", "ignore"],
    });
    runCommand(
      executor,
      openshellBin,
      ["forward", "start", "--background", DASHBOARD_FORWARD_PORT, targetForwardSandbox],
      { env: recoveryEnv, stdio: ["ignore", "ignore", "ignore"] },
    );
    output(`  Dashboard forward ready for sandbox '${targetForwardSandbox}' on port 18789.`);
  }

  if (opts.withServices && targetForwardSandbox) {
    const { startAll } = require("./services");
    await startAll({ sandboxName: targetForwardSandbox });
  }

  if (recovered === 0) {
    throw new Error("Startup recovery did not restore any registered sandbox.");
  }

  return { recovered, failed, defaultSandbox: targetForwardSandbox };
}

function formatStartupHelp() {
  return [
    "Install or run host startup recovery for NemoClaw sandboxes.",
    "",
    "Usage:",
    "  nemoclaw startup enable [--with-services]",
    "  nemoclaw startup disable",
    "  nemoclaw startup status",
    "  nemoclaw startup run [--with-services]",
    "",
    "Options:",
    "  --with-services   Also start auxiliary services (cloudflared) after recovery",
    "  --help, -h        Show this help",
    "",
    "Notes:",
    "  - Linux installs a systemd user service.",
    "  - macOS installs a LaunchAgent.",
    "  - Ensure your container runtime (Docker Desktop, Docker Engine, Colima) also starts automatically.",
  ].join("\n");
}

function parseStartupArgs(args) {
  const opts = {
    action: "",
    help: false,
    withServices: false,
  };
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg === "--with-services") {
      opts.withServices = true;
      continue;
    }
    if (!opts.action) {
      opts.action = arg;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return opts;
}

async function runStartupCommand(args, deps = {}) {
  const output = deps.output || console.log;
  const opts = parseStartupArgs(args);
  const commandOpts = {
    home: deps.home,
    nodeBin: deps.nodeBin,
    openshellBin: deps.openshellBin,
    pathValue: deps.pathValue,
    platform: deps.platform,
    rootDir: deps.rootDir,
    cliPath: deps.cliPath,
  };
  if (opts.help || !opts.action) {
    output(formatStartupHelp());
    return { code: 0, help: true };
  }

  switch (opts.action) {
    case "enable": {
      const result = installStartup({ ...commandOpts, withServices: opts.withServices }, deps);
      output("");
      output(
        `  Enabled NemoClaw startup recovery via ${result.manager === "systemd-user" ? "systemd user service" : "LaunchAgent"}.`,
      );
      output(`  Launcher: ${result.paths.scriptPath}`);
      output(
        `  Definition: ${result.manager === "systemd-user" ? result.paths.systemdUnitPath : result.paths.launchAgentPath}`,
      );
      output("  Ensure your container runtime also starts automatically on login/boot.");
      output("");
      return { code: 0, action: "enable", ...result };
    }
    case "disable": {
      const result = uninstallStartup(commandOpts, deps);
      output("");
      output("  Disabled NemoClaw startup recovery.");
      output("");
      return { code: 0, action: "disable", ...result };
    }
    case "status": {
      const status = getStartupStatus(commandOpts, deps);
      output("");
      output(
        `  Startup recovery: ${status.installed ? "installed" : "not installed"} (${status.manager})`,
      );
      output(`  Enabled: ${status.enabled}`);
      output(`  Launcher: ${status.paths.scriptPath}`);
      output(
        `  Definition: ${status.manager === "systemd-user" ? status.paths.systemdUnitPath : status.paths.launchAgentPath}`,
      );
      output("");
      return { code: 0, action: "status", ...status };
    }
    case "run": {
      const result = await runStartupRecovery({ withServices: opts.withServices }, deps);
      output("");
      output(
        `  Startup recovery complete. Restored ${String(result.recovered)} sandbox(es); ${String(result.failed)} failed.`,
      );
      output("");
      return { code: 0, action: "run", ...result };
    }
    default:
      throw new Error(`Unknown startup action: ${opts.action}`);
  }
}

module.exports = {
  DASHBOARD_FORWARD_PORT,
  LAUNCH_AGENT_LABEL,
  SYSTEMD_SERVICE_NAME,
  buildLaunchAgentPlist,
  buildStartupScript,
  buildSystemdUnit,
  formatStartupHelp,
  getStartupPaths,
  getStartupStatus,
  installStartup,
  parseStartupArgs,
  runStartupCommand,
  runStartupRecovery,
  uninstallStartup,
};
