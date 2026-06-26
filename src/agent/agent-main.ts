import { NodePortScanner } from "../platform/ports/node-port-scanner";
import { NodeListeningPortProvider } from "../platform/ports/node-listening-port-provider";
import { NodeProcessEnvironmentProvider } from "../platform/process/node-process-environment";
import { NodeProcessLauncher } from "../platform/process/node-process-launcher";
import { disableNativeHookForCurrentProcess } from "../platform/process/node-runtime";
import { PortManagerAgent } from "./port-manager-agent";

/**
 * CLI entrypoint for the single local Port Manager agent.
 *
 * The VS Code extension or a launcher process supplies the socket path. This
 * module only wires default Node/platform adapters and exits when the socket
 * server fails, allowing the caller to decide whether to restart the daemon.
 */

interface ParsedArguments {
  /** Local socket or named-pipe path where the agent should listen. */
  readonly socketPath: string;
}

void main(process.argv.slice(2));

/**
 * Starts the agent with production adapters. Errors are written to stderr and
 * become a non-zero process exit so daemon launch failures are visible.
 */
async function main(args: readonly string[]): Promise<void> {
  try {
    disableNativeHookForCurrentProcess();
    const parsedArguments = parseArguments(args);
    const agent = new PortManagerAgent({
      processLauncher: new NodeProcessLauncher(),
      portAvailabilityProvider: new NodePortScanner(),
      listeningPortProvider: new NodeListeningPortProvider(),
      hookRouteRecoveryProvider: new NodeProcessEnvironmentProvider(),
      routeTablePath: process.env.PORT_MANAGER_ROUTES_FILE,
      agentMainPath: __filename,
    });

    agent.onServerError((error) => {
      console.error(error.message);
      process.exit(1);
    });

    await agent.listen(parsedArguments.socketPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

/**
 * Parses the minimal daemon CLI. Keeping the parser explicit avoids pulling a
 * command framework into the extension package for one required argument.
 */
function parseArguments(args: readonly string[]): ParsedArguments {
  const socketFlagIndex = args.indexOf("--socket");
  const socketPath = socketFlagIndex >= 0 ? args[socketFlagIndex + 1] : undefined;

  if (socketPath === undefined || socketPath.trim().length === 0) {
    throw new Error("Usage: port-manager-agent --socket <path>");
  }

  return {
    socketPath,
  };
}
