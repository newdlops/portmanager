import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as vscode from "vscode";
import type { PortManagerNetworkService } from "../../src/extension/network-service";
import type { LogicalNetworkRegistry } from "../../src/core/networks/logical-network-registry";
import type { NativeProcessIdentity, NativeProcessLookupProvider } from "../../src/platform/process/native-process-lookup";
import type { ProxyNetworkResources } from "../../src/platform/ports/proxy-network-resources";
import { fixtureWitnessWriterSource, publishFixtureWitness } from "./fixture-witness";

/** Real installed SDK terminals, private readiness and byte witnesses share the soak owner. */
export async function preparePackagedTerminalLifecycle(service: PortManagerNetworkService, moduleRoot: string, reportPath: string) {
  const load = (relative: string) => require(path.join(moduleRoot, "out/src", relative));
  const { loopbackAddressForNetwork } = load("core/networks/loopback-address") as typeof import("../../src/core/networks/loopback-address");
  const { networkNamespacePaths } = load("platform/process/network-file-scaffold") as typeof import("../../src/platform/process/network-file-scaffold");
  const { NativeProcessLookupProvider } = load("platform/process/native-process-lookup") as typeof import("../../src/platform/process/native-process-lookup");
  const { defaultProxyNetworkResources: resources } = load("platform/ports/proxy-network-resources") as { defaultProxyNetworkResources: ProxyNetworkResources };
  const registry = (service as unknown as { registry: LogicalNetworkRegistry }).registry;
  const workspace = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const node = process.env.PM_TEST_NODE_EXECUTABLE!;
  assert.ok(path.isAbsolute(node));
  fs.accessSync(node, fs.constants.X_OK);
  const lookup: NativeProcessLookupProvider = new NativeProcessLookupProvider({ helperPath: path.join(moduleRoot, "media/native/portmanager_process_lookup") });
  // Reuse already-configured aliases. The test never asks for admin privileges
  // or changes the user's lo0/resolver configuration to manufacture a pass.
  const aliases = new Set(Object.values(os.networkInterfaces()).flatMap(rows => rows ?? [])
    .filter(row => row.internal && row.family === "IPv4" && /^127\.(?:[89]\d|10\d|11[01])\./.test(row.address)).map(row => row.address));
  const selected: { id: string; host: string }[] = [];
  for (let index = 0; index < 8_000_000 && selected.length < 2; index++) {
    const id = `installed-terminal-${index}`;
    const host = loopbackAddressForNetwork(id);
    if (aliases.has(host) && !selected.some(row => row.host === host)) selected.push({ id, host });
  }
  assert.equal(selected.length, 2, "Two existing logical-network aliases are required for actual cross-network terminal validation.");
  for (const row of selected) registry.addNetwork({ id: row.id, name: row.id, runtimeKind: "nativeHelper", status: "running", createdAt: new Date().toISOString() });
  const clients = new Set<net.Socket>();
  const servers = selected.map((row, index) => net.createServer(socket => {
    clients.add(socket); socket.on("error", () => {}); socket.once("close", () => clients.delete(socket));
    socket.on("data", bytes => socket.end(`${index === 0 ? "A" : "B"}:${bytes.toString()}`));
  }));
  for (let index = 0; index < servers.length; index++) await new Promise<void>((resolve, reject) => {
    servers[index].once("error", reject); servers[index].listen(0, selected[index].host, resolve);
  });
  const ports = servers.map(server => (server.address() as net.AddressInfo).port);
  // Both backends really accept traffic from the unconfined host before an
  // in-sandbox denial is accepted as an isolation result.
  for (let index = 0; index < selected.length; index++) assert.equal(await exchange(selected[index].host, ports[index], "outside"), `${index === 0 ? "A" : "B"}:outside`);
  const bindings = selected.map((row, index) => service.createHostAccessBinding({ networkId: row.id,
    logicalPort: 4567, hostAddress: row.host, hostPort: ports[index] }));
  const foreignFile = path.join(networkNamespacePaths(workspace, selected[1].id).filesDirectory, "kernel-fixture.dat");
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(foreignFile, "synthetic fixture", { mode: 0o600 });
  const records: unknown[] = [];
  const terminals = new Set<vscode.Terminal>();
  const scripts = new Set<string>();
  // sendText can arrive before the interactive shell enables line editing.
  // Keep its PTY input below the canonical line buffer instead of pasting a
  // multi-kilobyte quoted program; the same code runs from the shared fixture.
  const sendProgram = (terminal: vscode.Terminal, program: string, name: string): string => {
    const file = path.join(workspace, name);
    fs.writeFileSync(file, program, { mode: 0o600 });
    scripts.add(file);
    terminal.sendText(`${quote(node)} ${quote(file)}`, true);
    return file;
  };
  const save = () => publishFixtureWitness(reportPath, { platform: process.platform, installedModuleRoot: moduleRoot,
    networks: selected, cycles: records.length, records });
  async function identity(terminal: vscode.Terminal): Promise<NativeProcessIdentity> {
    const supervisorPid = await terminal.processId;
    assert.ok(supervisorPid);
    const current = await lookup.readProcessIdentity(supervisorPid);
    assert.ok(current, "The actual SDK PTY supervisor must have an OS birth identity.");
    return current;
  }
  async function gone(original: NativeProcessIdentity): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await lookup.readProcessIdentity(original.pid);
      if (current === undefined || current.birth !== original.birth) return;
      await delay(200);
    }
    throw new Error("Previous actual PTY supervisor survived terminal replacement/close.");
  }
  async function probe(terminal: vscode.Terminal, cycle: number, label: "A" | "B", negative: boolean): Promise<unknown> {
    const witness = path.join(workspace, `terminal-${cycle}-${label}.json`);
    const sharedSource = path.join(workspace, "terminal-shared-source.ts");
    const program = `const fs=require('node:fs'),net=require('node:net');${fixtureWitnessWriterSource()}
      const connect=(host,port)=>new Promise((resolve,reject)=>{const s=net.connect(port,host);let data='';s.setTimeout(2500,()=>s.destroy(new Error('deadline')));s.on('connect',()=>s.end('inside'));s.on('data',b=>data+=b);s.on('end',()=>resolve(data));s.on('error',reject)});
      (async()=>{const result={pid:process.pid,networkId:process.env.PORT_MANAGER_NETWORK_ID};
        result.value=await connect('127.0.0.1',4567);if(result.value!==${JSON.stringify(label + ":inside")})throw new Error('wrong scoped backend');
        fs.writeFileSync(${JSON.stringify(sharedSource)},'export const shared = true;\\n');
        if(${negative}){result.dns=(await require('node:dns').promises.lookup('example.com')).family;
          try{await connect(${JSON.stringify(selected[1].host)},${ports[1]});throw new Error('foreign TCP permitted')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;result.foreignTcp=e.code}
          try{fs.readFileSync(${JSON.stringify(foreignFile)});throw new Error('foreign namespace permitted')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;result.foreignFile=e.code}
          process.env.PORT_MANAGER_NETWORK_ID=${JSON.stringify(selected[1].id)};process.env.PORT_MANAGER_HOOK='0';process.env.PORT_MANAGER_HOOK_DISABLED='1';
          try{await connect(${JSON.stringify(selected[1].host)},${ports[1]});throw new Error('forged scope permitted')}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;result.forgedScope=e.code}
        }publishWitness(${JSON.stringify(witness)},result);
      })().catch(e=>publishWitness(${JSON.stringify(witness)},{error:String(e),code:e.code}));`;
    const programFile = sendProgram(terminal, program, `terminal-${cycle}-${label}.cjs`);
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(witness)) { assert.ok(Date.now() < deadline, "Actual installed terminal did not produce its byte witness."); await delay(20); }
    const result = JSON.parse(fs.readFileSync(witness, "utf8"));
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.networkId, selected[label === "A" ? 0 : 1].id);
    assert.equal(result.value, `${label}:inside`);
    assert.equal(fs.readFileSync(sharedSource, "utf8"), "export const shared = true;\n");
    fs.unlinkSync(witness);
    fs.unlinkSync(programFile); scripts.delete(programFile);
    return result;
  }
  return {
    async exercise(cycle: number): Promise<void> {
      const started = Date.now();
      // The first cycle includes SDK profile adoption and two recovery paths.
      // Identify which await exhausted its existing budget without tracing
      // the installed product or changing the measured later cycles.
      const stage = (name: string) => {
        if (cycle === 1) console.log(`Installed terminal stage: ${name} elapsedMs=${Date.now() - started}`);
      };
      stage("begin");
      const before = resources.budget.used;
      const priorProfile = vscode.workspace.getConfiguration("terminal.integrated").inspect<string>("defaultProfile.osx")?.workspaceValue;
      if (cycle === 1) {
        await service.attachVscodeWindowTerminalsToNetwork(selected[0].id);
        stage("default profile configured");
        assert.equal(service.getGuardedDefaultNetworkId(), selected[0].id);
        assert.equal(vscode.workspace.getConfiguration("terminal.integrated").get("defaultProfile.osx"), "Port Manager: Logical Network");
      }
      const canceled = await service.prepareGuardedTerminalOptions(selected[0].id, workspace);
      await service.cancelGuardedTerminalOptions(canceled);
      stage("canceled profile reclaimed");
      assert.deepEqual(resources.budget.used, before, "Canceled SDK profile retained a reservation.");
      let terminal: vscode.Terminal;
      if (cycle === 1) {
        const profileTerminal = new Promise<vscode.Terminal>((resolve, reject) => {
          const timer = setTimeout(() => { subscription.dispose(); reject(new Error("Default guarded profile did not create a terminal.")); }, 10_000);
          const subscription = vscode.window.onDidOpenTerminal(opened => {
            const creation = opened.creationOptions;
            if (!("env" in creation) || typeof creation.env?.PORT_MANAGER_GUARDED_SESSION_ID !== "string") return;
            clearTimeout(timer); subscription.dispose(); resolve(opened);
          });
        });
        await vscode.commands.executeCommand("workbench.action.terminal.new");
        stage("SDK new terminal command returned");
        terminal = await profileTerminal;
        stage("SDK profile terminal opened");
        const session = (terminal.creationOptions as vscode.TerminalOptions).env!.PORT_MANAGER_GUARDED_SESSION_ID;
        const deadline = Date.now() + 10_000;
        while (!service.getSnapshot().attachments.some(row => row.id === `guarded-${session}` && row.status === "attached")) {
          assert.ok(Date.now() < deadline, "Default profile did not authenticate its actual PTY."); await delay(20);
        }
      } else terminal = await service.openGuardedNetworkTerminal(selected[0].id, workspace);
      terminals.add(terminal);
      const original = await identity(terminal);
      stage("A supervisor identified");
      const a = await probe(terminal, cycle, "A", cycle === 1);
      stage("A byte witness complete");
      if (cycle === 1) {
        console.log("Installed terminal lifecycle: first guarded PTY and byte witness ready.");
        const visualHold = Number(process.env.PM_TEST_TERMINAL_VISUAL_HOLD_SECONDS ?? 0);
        assert.ok(Number.isInteger(visualHold) && visualHold >= 0 && visualHold <= 10);
        if (visualHold > 0) {
          // A SDK-created PTY can execute while its panel remains hidden.
          // Show only this explicitly requested visual-QA terminal; the
          // normal resource gate retains its original UI behavior.
          terminal.show(true);
          await delay(visualHold * 1000);
        }
      }
      const peak = resources.budget.used;
      stage("replace requested");
      const replacement = await service.replaceGuardedTerminal(terminal, selected[1].id);
      stage("replacement created");
      terminals.delete(terminal); terminal = replacement; terminals.add(terminal);
      await gone(original);
      stage("A supervisor reclaimed");
      const b = await probe(terminal, cycle, "B", false);
      stage("B byte witness complete");
      const current = await identity(terminal);
      const detachedReady = new Promise<vscode.Terminal>((resolve, reject) => {
        const timer = setTimeout(() => { subscription.dispose(); reject(new Error("Fresh host terminal was not created.")); }, 10_000);
        const subscription = vscode.window.onDidOpenTerminal(opened => {
          if (opened.name !== "Port Manager: detached") return;
          clearTimeout(timer); subscription.dispose(); resolve(opened);
        });
      });
      const creation = terminal.creationOptions;
      const session = "env" in creation ? creation.env?.PORT_MANAGER_GUARDED_SESSION_ID : undefined;
      assert.equal(typeof session, "string");
      stage("detach requested");
      assert.ok(await service.detachTerminal(`guarded-${session}`));
      stage("detach returned");
      terminals.delete(terminal);
      await gone(current);
      const detached = await detachedReady;
      terminals.add(detached);
      const detachedIdentity = await identity(detached);
      stage("host supervisor identified");
      assert.notEqual(detachedIdentity.pid, current.pid, "Detach must create a fresh host process.");
      const detachedWitness = path.join(workspace, `terminal-${cycle}-detached.json`);
      const hostProgram = `const fs=require('node:fs'),net=require('node:net');${fixtureWitnessWriterSource()}const s=net.connect(${ports[1]},${JSON.stringify(selected[1].host)});let value='';s.on('connect',()=>s.end('host'));s.on('data',b=>value+=b);s.on('end',()=>publishWitness(${JSON.stringify(detachedWitness)},{value,networkId:process.env.PORT_MANAGER_NETWORK_ID??null,foreignFile:fs.readFileSync(${JSON.stringify(foreignFile)},'utf8')}));s.on('error',e=>publishWitness(${JSON.stringify(detachedWitness)},{error:String(e)}));`;
      const hostProgramFile = sendProgram(detached, hostProgram, `terminal-${cycle}-detached.cjs`);
      const hostDeadline = Date.now() + 10_000;
      while (!fs.existsSync(detachedWitness)) { assert.ok(Date.now() < hostDeadline); await delay(20); }
      assert.deepEqual(JSON.parse(fs.readFileSync(detachedWitness, "utf8")), { value: "B:host", networkId: null, foreignFile: "synthetic fixture" });
      stage("host byte witness complete");
      fs.unlinkSync(detachedWitness);
      fs.unlinkSync(hostProgramFile); scripts.delete(hostProgramFile);
      detached.dispose(); terminals.delete(detached);
      await gone(detachedIdentity);
      stage("host supervisor reclaimed");
      if (cycle === 1) {
        await service.detachVscodeWindowTerminalsFromNetwork();
        stage("default profile restored");
        assert.equal(service.getGuardedDefaultNetworkId(), undefined);
        assert.equal(vscode.workspace.getConfiguration("terminal.integrated").inspect<string>("defaultProfile.osx")?.workspaceValue, priorProfile);
        for (const forced of [false, true]) {
          stage(`orphan ${forced} open requested`);
          const closing = await service.openGuardedNetworkTerminal(selected[0].id, workspace);
          stage(`orphan ${forced} terminal opened`);
          terminals.add(closing);
          const parentIdentity = await identity(closing);
          const orphanWitness = path.join(workspace, `terminal-${cycle}-orphan-${forced}.json`);
          const daemonProgram = `${fixtureWitnessWriterSource()}const c=require('node:child_process').spawn(${JSON.stringify(node)},['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore',env:{...process.env}});publishWitness(${JSON.stringify(orphanWitness)},{pid:c.pid});c.unref();`;
          const daemonProgramFile = sendProgram(closing, daemonProgram, `terminal-${cycle}-orphan-${forced}.cjs`);
          const orphanDeadline = Date.now() + 10_000;
          while (!fs.existsSync(orphanWitness)) { assert.ok(Date.now() < orphanDeadline); await delay(20); }
          const orphanPid = JSON.parse(fs.readFileSync(orphanWitness, "utf8")).pid as number;
          const orphan = await lookup.readProcessIdentity(orphanPid);
          assert.ok(orphan, "Actual installed terminal must leave a real detached child before close.");
          stage(`orphan ${forced} child identified`);
          if (forced) assert.equal(await lookup.signalProcess(parentIdentity, "SIGKILL"), true);
          // User-style SDK close and a deliberately vanished trusted parent
          // must both use the installed owner's census/receipt recovery path.
          closing.dispose(); terminals.delete(closing);
          await gone(parentIdentity);
          await gone(orphan);
          stage(`orphan ${forced} reclaimed`);
          fs.unlinkSync(orphanWitness);
          fs.unlinkSync(daemonProgramFile); scripts.delete(daemonProgramFile);
          records.push({ abruptClose: forced, supervisor: parentIdentity, orphan, reclaimed: true });
        }
      }
      const deadline = Date.now() + 10_000;
      while (JSON.stringify(resources.budget.used) !== JSON.stringify(before)) { assert.ok(Date.now() < deadline, "Terminal close retained a shared reservation."); await delay(20); }
      records.push({ cycle, a, b, peak, supervisor: original, replacement: current, detached: detachedIdentity, settled: resources.budget.used });
      save();
      stage("complete");
    },
    async close(): Promise<void> {
      for (const terminal of terminals) terminal.dispose();
      for (const file of scripts) fs.rmSync(file, { force: true });
      scripts.clear();
      for (const binding of bindings) service.removeHostAccessBinding(binding.id);
      for (const row of selected) registry.removeNetwork(row.id);
      for (const client of clients) client.destroy();
      await Promise.all(servers.map(server => new Promise<void>(resolve => server.close(() => resolve()))));
      save();
    },
  };
}

function quote(value: string): string { return "'" + value.replace(/'/g, "'\\''") + "'"; }
function exchange(host: string, port: number, value: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host); let result = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("Outside-host fixture deadline")));
    socket.once("connect", () => socket.end(value)); socket.on("data", bytes => result += bytes.toString());
    socket.once("error", reject); socket.once("end", () => resolve(result));
  });
}
