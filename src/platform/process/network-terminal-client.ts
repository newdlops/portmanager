import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { isatty, ReadStream } from "node:tty";
import { readPrivateBytes, type NetworkShellLaunch } from "./macos-network-runtime";
import { setTimeout as delay } from "node:timers/promises";
import { readTerminalControlToken } from "./network-terminal-control";
import { buildNodeRuntimeEnvironment } from "./node-runtime";

/** Keep the user's host shell alive until a guarded child finishes or fails. */
export function buildNetworkTerminalClientCommand(executable: string, cli: string, socket: string, token: string, networkId: string): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  // The sourced pm wrapper must not run legacy preload activation on return.
  return `__pm_guarded_terminal_client=1\n/usr/bin/env ELECTRON_RUN_AS_NODE=1 PORT_MANAGER_HOOK_DISABLED=1 ${[executable, cli, "terminal", socket, token, networkId].map(quote).join(" ")} "$PWD"`;
}

/**
 * Runs beneath the external host shell as a non-interactive trusted parent. Only
 * the private controller channel can choose another launch or detached shell;
 * guarded applications inherit standard IO, never this channel or key.
 */
export async function runNetworkTerminalClient(args: readonly string[], options: { readonly startupTimeoutMs?: number } = {}): Promise<void> {
  if (args.length !== 4 || process.platform !== "darwin") throw new Error("Invalid guarded terminal invocation.");
  const [socketPath, tokenPath, networkId, cwd] = args;
  const token = readTerminalControlToken(tokenPath);
  const socket = net.createConnection(socketPath);
  let currentCwd = cwd;
  let child: ChildProcess | undefined, buffer = "", changing = false, finished = false;
  const stopped = new Promise<void>((resolve, reject) => {
    // Preparing the owner can involve controller startup. A lost response must
    // return to the original prompt rather than occupy the terminal forever.
    let startup: NodeJS.Timeout;
    let menuTimer: NodeJS.Timeout | undefined;
    let cancelMenu: (() => void) | undefined;
    let menuBusy = false;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(startup);
      clearInterval(menuTimer);
      cancelMenu?.();
      for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
      socket.destroy();
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error !== undefined) reject(error); else resolve();
    };
    const armStartup = () => {
      clearTimeout(startup);
      startup = setTimeout(() => finish(new Error("Port Manager terminal startup timed out. Check the VS Code controller and retry pm.")), options.startupTimeoutMs ?? 30_000);
    };
    armStartup();
    const launch = (plan: NetworkShellLaunch) => {
      clearTimeout(startup);
      changing = false;
      currentCwd = plan.cwd;
      const environment = { ...buildNodeRuntimeEnvironment(), ...plan.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const launched = spawn(plan.shellPath, [...plan.shellArgs], { cwd: plan.cwd, env: environment, stdio: "inherit" });
      child = launched;
      clearInterval(menuTimer);
      cancelMenu?.();
      if (plan.menuRequestPath !== undefined) {
        const requestPath = plan.menuRequestPath;
        menuTimer = setInterval(() => {
          if (finished || changing || menuBusy || !fs.lstatSync(requestPath, { throwIfNoEntry: false })?.isFile()) return;
          menuBusy = true;
          const abort = new AbortController();
          cancelMenu = () => abort.abort();
          void selectTerminalMenu(plan, launched, abort.signal).then(async selection => {
            if (finished || changing || child !== launched) return;
            if (selection?.networkId !== undefined && selection.networkId !== plan.networkId) {
              changing = true; armStartup();
              socket.write(JSON.stringify({ type: "replace", networkId: selection.networkId }) + "\n");
            } else if (selection?.command === "detach") {
              changing = true; armStartup();
              socket.write(JSON.stringify({ type: "detach" }) + "\n");
            } else if (selection?.command !== undefined) {
              // Maintenance may ask for input too (for example TLS renewal).
              // Its host helper uses the same foreground group as this client.
              if (isatty(0)) await setMenuForeground(plan, launched, true, abort.signal);
              try { await runHostMenuCommand(selection.command, plan, abort.signal); }
              finally {
                if (isatty(0) && launched.exitCode === null && launched.signalCode === null) await setMenuForeground(plan, launched, false);
              }
            }
          }).catch(error => {
            if (!abort.signal.aborted) process.stderr.write(`Port Manager menu: ${String(error)}\n`);
          }).finally(() => {
            // Removing only the fixed marker resumes a canceled/diagnostic menu.
            // The parent never executes or selects a scope from its contents.
            try { fs.rmSync(requestPath, { force: true }); } catch { /* A replaced marker is never followed. */ }
            menuBusy = false; cancelMenu = undefined;
          });
        }, 100);
        menuTimer.unref();
      }
      launched.once("error", finish);
      launched.once("exit", code => {
        if (child !== launched || changing) return;
        process.exitCode = code ?? 1;
        finish();
      });
    };
    socket.once("connect", () => socket.write(JSON.stringify({ token, networkId, cwd }) + "\n"));
    socket.once("error", finish);
    socket.once("close", () => finish(new Error(child === undefined
      ? "Port Manager controller disconnected before the terminal started. Retry pm from the original prompt."
      : "Port Manager terminal controller disconnected.")));
    socket.on("data", bytes => {
      buffer += bytes.toString("utf8");
      if (Buffer.byteLength(buffer) > 64 * 1024) { finish(new Error("Terminal control frame exceeds its limit.")); return; }
      let end: number;
      while (!finished && (end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { type: string; launch?: NetworkShellLaunch; message?: string };
          if (message.type === "changing") { changing = true; cancelMenu?.(); armStartup(); }
          else if (message.type === "launch" && message.launch !== undefined) { changing = true; launch(message.launch); }
          else if (message.type === "detach") {
            clearTimeout(startup);
            clearInterval(menuTimer);
            cancelMenu?.();
            changing = true;
            const environment = buildNodeRuntimeEnvironment(); delete environment.ELECTRON_RUN_AS_NODE;
            const detached = spawn(process.env.SHELL ?? "/bin/zsh", ["-i"], { cwd: currentCwd, env: environment, stdio: "inherit" });
            child = detached;
            detached.once("error", finish); detached.once("exit", code => { process.exitCode = code ?? 1; finish(); });
          } else if (message.type === "request-error") {
            changing = false; clearTimeout(startup);
            process.stderr.write(`Port Manager: ${message.message ?? "Could not change network."}\n`);
          } else if (message.type === "error") finish(new Error(message.message ?? "Guarded terminal startup failed."));
          else finish(new Error("Invalid terminal controller response."));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
      const handler = () => {
        if (signal === "SIGINT" && cancelMenu !== undefined) { cancelMenu(); return; }
        if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
        else finish(new Error("Port Manager terminal startup canceled."));
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
  });
  await stopped;
}

interface TerminalMenuSelection { readonly networkId?: string; readonly command?: string }

/** The trusted host reads the same exported list as the original shell menu.
 * A workload can only request that this UI opens; it cannot provide a choice. */
async function selectTerminalMenu(plan: NetworkShellLaunch, supervisor: ChildProcess, signal: AbortSignal): Promise<TerminalMenuSelection | undefined> {
  const file = process.env.PORT_MANAGER_NETWORKS_FILE ?? path.join(os.homedir(),
    "Library/Application Support/Code/User/globalStorage/newdlops.portmanager/terminal-networks.tsv");
  const stat = fs.statSync(file);
  if (stat.size > 256 * 1024) throw new Error("Network selection file exceeds its limit.");
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  const rows = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
    .map(line => line.split("\t")).filter(row => row.length >= 3);
  for (const [index, row] of rows.entries()) {
    process.stderr.write(`${row[0] === plan.networkId ? "*" : " "} ${index + 1}) ${clean(row[1])} [${clean(row[0])}]\n`);
    for (const summary of (row[3] || "no services").split(/\s+\|\|\s+/)) process.stderr.write(`     ${clean(summary)}\n`);
  }
  process.stderr.write("Commands: current, status, version, doctor, routes, repair, clean, detach, help\n");
  // Read through a duplicate, then close it completely before handing stdin
  // back to a shell. Keeping process.stdin's pipe reader paused can consume a
  // command intended for the replacement/detached child during its handoff.
  const terminal = isatty(0);
  let menuInput: ReadStream | net.Socket | undefined;
  let choice: string | undefined;
  try {
    if (terminal) await setMenuForeground(plan, supervisor, true, signal);
    const fd = fs.openSync("/dev/fd/0", "r");
    menuInput = terminal ? new ReadStream(fd) : new net.Socket({ fd, readable: true, writable: false });
    // A late error after readline closes belongs to its retired duplicate.
    menuInput.on("error", () => {});
    const input = createInterface({ input: menuInput, output: process.stderr, terminal });
    choice = await new Promise<string | undefined>((resolve, reject) => {
      const cancel = () => { input.close(); resolve(undefined); };
      signal.addEventListener("abort", cancel, { once: true });
      input.once("close", () => { menuInput?.destroy(); signal.removeEventListener("abort", cancel); resolve(undefined); });
      input.once("error", error => { reject(error); input.close(); });
      input.once("SIGINT", cancel);
      input.question("Select Port Manager network (Enter to cancel): ", value => { resolve(value.trim()); input.close(); });
      if (signal.aborted) cancel();
    });
  } finally {
    menuInput?.destroy();
    if (terminal && plan.terminalForegroundPath !== undefined && supervisor.exitCode === null && supervisor.signalCode === null)
      await setMenuForeground(plan, supervisor, false);
  }
  if (!choice || choice === "q" || choice === "quit") return;
  if (["current", "status", "version", "doctor", "routes", "repair", "clean", "detach", "help"].includes(choice)) return { command: choice };
  const matching = /^\d+$/.test(choice) ? rows.filter((_row, index) => index + 1 === Number(choice))
    : rows.filter(row => row[0] === choice || row[1] === choice);
  if (matching.length !== 1) throw new Error(`Network ${matching.length === 0 ? "not found" : "name is ambiguous"}: ${clean(choice)}`);
  return { networkId: matching[0][0] };
}

/** The existing trusted supervisor owns job control. Its private atomic ack
 * is checked before a menu reader opens, and before the shell resumes. */
async function setMenuForeground(plan: NetworkShellLaunch, supervisor: ChildProcess, active: boolean, signal?: AbortSignal): Promise<void> {
  if (plan.terminalForegroundPath === undefined) throw new Error("Terminal controller does not support pm menu input. Reload its VS Code window.");
  if (!supervisor.kill(active ? "SIGUSR1" : "SIGUSR2")) throw new Error("Terminal supervisor is no longer available.");
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    if (signal?.aborted) throw new Error("Terminal menu canceled.");
    try {
      const record = JSON.parse(readPrivateBytes(plan.terminalForegroundPath, 256).toString("utf8")) as { supervisorPid?: unknown; active?: unknown };
      if (record.supervisorPid === supervisor.pid && record.active === active) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (supervisor.exitCode !== null || supervisor.signalCode !== null) throw new Error("Terminal supervisor exited during menu input.");
    await delay(20);
  }
  throw new Error("Terminal menu input handoff timed out.");
}

/** Host-side diagnostics reuse the installed full command library. Arguments
 * are fixed menu choices and controller coordinates, never marker contents. */
export async function runHostMenuCommand(command: string, plan: NetworkShellLaunch,
  signal?: AbortSignal, capture = false): Promise<string> {
  if (!["current", "status", "version", "doctor", "routes", "repair", "clean", "help"].includes(command)) throw new Error("Invalid host menu command.");
  const library = path.join(os.homedir(), ".portmanager", "portmanager-commands.sh");
  const environment = buildNodeRuntimeEnvironment();
  delete environment.ELECTRON_RUN_AS_NODE;
  environment.PORT_MANAGER_NETWORK_ID = plan.networkId;
  environment.PORT_MANAGER_NETWORK_NAME = plan.networkName ?? plan.networkId;
  const output = await new Promise<string>((resolve, reject) => {
    const helper = spawn("/bin/zsh", ["-dfc", '. "$1" || exit; pm "$2"', "pm-menu", library, command],
      { cwd: plan.cwd, env: environment, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit", signal });
    let text = "";
    const collect = (bytes: Buffer) => { text = (text + bytes.toString("utf8")).slice(-64 * 1024); };
    helper.stdout?.on("data", collect); helper.stderr?.on("data", collect);
    helper.once("error", reject); helper.once("close", () => resolve(text));
  });
  if (!capture && !signal?.aborted) process.stdout.write(`\x1b]0;Port Manager: ${(plan.networkName ?? plan.networkId).replace(/[\u0000-\u001f\u007f-\u009f]/g, "")}\x07`);
  return output;
}
