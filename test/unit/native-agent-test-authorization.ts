import fs from "node:fs";
import path from "node:path";
import { ensureAgentControllerToken, readAgentControllerToken } from "../../src/agent/agent-authorization";

/** Credentials stay beside each disposable test socket, never in the real
 * user's controller store. Tests use the same authenticated wire protocol. */
export function testAgentCredentialPath(socketPath: string): string {
  return path.join(fs.realpathSync(path.dirname(socketPath)), "private-control", "controller.key");
}

export function createTestAgentCredential(socketPath: string): string {
  const tokenPath = testAgentCredentialPath(socketPath);
  ensureAgentControllerToken(tokenPath);
  return tokenPath;
}

export function testAgentAuthorization(socketPath: string): string {
  return readAgentControllerToken(testAgentCredentialPath(socketPath));
}
