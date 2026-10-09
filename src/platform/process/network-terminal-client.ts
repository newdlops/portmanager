import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { NetworkShellLaunch } from "./macos-network-runtime";
import { readTerminalControlToken } from "./network-terminal-control";
import { buildNodeRuntimeEnvironment } from "./node-runtime";

/**
 * Replaces the external host shell with a non-interactive trusted parent. Only
 * the private controller channel can choose another launch or detached shell;
 * guarded applications inherit standard IO, never this channel or key.
 */
export async function runNetworkTerminalClient(args: readonly string[]): Promise<void> {
  if (args.length !== 4 || process.platform !== "darwin") throw new Error("Invalid guarded terminal invocation.");
  const [socketPath, tokenPath, networkId, cwd] = args;
  const token = readTerminalControlToken(tokenPath);
  const socket = net.createConnection(socketPath);
  let currentCwd = cwd;
  let child: ChildProcess | undefined, buffer = "", changing = false, finished = false;
  const stopped = new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      if (error !== undefined) reject(error); else resolve();
    };
    const launch = (plan: NetworkShellLaunch) => {
      changing = false;
      currentCwd = plan.cwd;
      const environment = { ...buildNodeRuntimeEnvironment(), ...plan.env };
      delete environment.ELECTRON_RUN_AS_NODE;
      const launched = spawn(plan.shellPath, [...plan.shellArgs], { cwd: plan.cwd, env: environment, stdio: "inherit" });
      child = launched;
      launched.once("error", finish);
      launched.once("exit", code => {
        if (child !== launched || changing) return;
        process.exitCode = code ?? 1;
        finish();
      });
    };
    socket.once("connect", () => socket.write(JSON.stringify({ token, networkId, cwd }) + "\n"));
    socket.once("error", finish);
    socket.once("close", () => finish());
    socket.on("data", bytes => {
      buffer += bytes.toString("utf8");
      if (Buffer.byteLength(buffer) > 64 * 1024) { finish(new Error("Terminal control frame exceeds its limit.")); return; }
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = JSON.parse(line) as { type: string; launch?: NetworkShellLaunch; message?: string };
          if (message.type === "changing") changing = true;
          else if (message.type === "launch" && message.launch !== undefined) { changing = true; launch(message.launch); }
          else if (message.type === "detach") {
            changing = true;
            const environment = buildNodeRuntimeEnvironment(); delete environment.ELECTRON_RUN_AS_NODE;
            const detached = spawn(process.env.SHELL ?? "/bin/zsh", ["-i"], { cwd: currentCwd, env: environment, stdio: "inherit" });
            child = detached;
            detached.once("error", finish); detached.once("exit", code => { process.exitCode = code ?? 1; finish(); });
          } else if (message.type === "error") finish(new Error(message.message ?? "Guarded terminal startup failed."));
          else finish(new Error("Invalid terminal controller response."));
        } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
      }
    });
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => {
      if (child?.exitCode === null && child.signalCode === null) child.kill(signal);
    });
  });
  await stopped;
}
