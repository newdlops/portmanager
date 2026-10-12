import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const run = promisify(execFile);
interface Identity { pid: number; birth: number; ppid?: number; sid?: number }

/** Natural root exit, raw double-fork/setsid and inherited TTY authority are
 * stronger witnesses than an orderly shell exit or a PID-only mock. */
test("supervisor reclaims escaped and churning descendants before returning or reusing a terminal", {
  skip: process.platform !== "darwin", timeout: 90_000,
}, async context => {
  const source = path.resolve(__dirname, "../../.."), root = fs.mkdtempSync("/private/tmp/pm-launch-clean-");
  const children: ChildProcess[] = [];
  const runtime = path.join(root, ".portmanager/runtime"), profiles = path.join(root, ".portmanager/security/profiles"), sockets = path.join(root, ".portmanager/security/sockets");
  for (const directory of [runtime, profiles, sockets]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcher = path.join(runtime, "launch"), broker = path.join(runtime, "broker"), hook = path.join(runtime, "hook.dylib");
  const fixture = path.join(root, "fixture"), identity = path.join(root, "identity"), log = path.join(root, "launch.log");
  context.after(async () => {
    if (fs.existsSync(log)) context.diagnostic(fs.readFileSync(log, "utf8"));
    for (const child of children.reverse()) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const ended = once(child, "exit"); child.kill("SIGTERM"); await Promise.race([ended, delay(4000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await ended; }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const compile = (files: string[], output: string, extra: string[] = []) => execFileSync("cc", ["-O2", "-Wall", "-Wextra", "-Werror", ...extra,
    ...files.map(file => path.join(source, file)), "-o", output], { timeout: 30_000 });
  compile(["native/network-launcher/portmanager_network_launch.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], launcher);
  compile(["native/network-broker/portmanager_network_broker.c", "native/agent/portmanager_agent_json.c", "native/shared/pm_dev_log.c"], broker);
  compile(["test/unit/native-network-launcher-cleanup-fixture.c"], fixture);
  compile(["native/process-lookup/portmanager_process_lookup.c"], identity);
  compile(["native/hook/portmanager_hook.c", "native/shared/pm_dev_log.c"], hook, ["-dynamiclib", "-Wno-unused-function",
    ...(process.arch === "arm64" ? ["-arch", "arm64", "-arch", "arm64e"] : [])]);
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_HOOK_DISABLED: "1", PORT_MANAGER_DEV_LOG: log };
  delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD; delete environment.BASH_ENV; delete environment.ENV;
  assert.equal((await run(fixture, ["generation"], { env: environment, timeout: 3000 })).stdout.trim(), "generation-ok");
  const prepare = async (id: string) => {
    const endpoint = path.join(sockets, `${id}.sock`), policy = path.join(profiles, `${id}.sb`);
    const own = networkNamespacePaths(root, id); fs.mkdirSync(own.filesDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(policy, buildMacosNetworkSandboxProfile({ networkId: id, namespaceDirectories: [own.directory], sharedWorkspaceDirectories: [root], agentSocketPath: endpoint }), { mode: 0o600 });
    const helper = spawn(broker, ["--socket", endpoint, "--network-id", id, "--loopback-host", "127.0.0.1"], { env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(helper);
    assert.match((await once(helper.stdout!, "data"))[0].toString(), /ready/);
    return { id, endpoint, policy };
  };
  const a = await prepare("a"), b = await prepare("b");
  const args = (scope: typeof a, command: string[]) => ["--profile", scope.policy, "--broker", scope.endpoint, "--hook", hook, "--network-id", scope.id, "--announce-ready", "--", ...command];
  const alive = (saved: Identity) => {
    try { const current = JSON.parse(execFileSync(identity, ["identity", String(saved.pid)], { env: environment, encoding: "utf8", timeout: 2000 })) as Identity;
      return current.pid === saved.pid && current.birth === saved.birth;
    } catch { return false; }
  };
  const host = spawn(fixture, ["hold"], { env: environment, stdio: ["ignore", "pipe", "pipe"] }); children.push(host); await once(host.stdout!, "data");
  const hostIdentity = JSON.parse(execFileSync(identity, ["identity", String(host.pid)], { encoding: "utf8" })) as Identity;
  const other = spawn(launcher, args(b, [fixture, "hold"]), { env: environment, cwd: root, stdio: ["ignore", "pipe", "pipe"] }); children.push(other);
  let otherOutput = ""; other.stdout!.on("data", bytes => otherOutput += bytes.toString());
  async function until(predicate: () => boolean, label: string, milliseconds = 5000) {
    const deadline = Date.now() + milliseconds;
    while (!predicate()) { assert.ok(Date.now() < deadline, label); await delay(10); }
  }
  await until(() => /ready pid=\d+ birth=\d+/.test(otherOutput) && otherOutput.includes("holding"), "other namespace fixture did not start");
  const match = /ready pid=(\d+) birth=(\d+)/.exec(otherOutput)!;
  const otherIdentity = { pid: Number(match[1]), birth: Number(match[2]) };
  for (const mode of ["plain", "churn", "sip", "nested"]) {
    const report = path.join(root, `${mode}-report.js`), ticks = path.join(root, `${mode}-ticks.js`);
    const sipReady = path.join(root, "sip-ready.js");
    const result = await run(launcher, args(a, [fixture, "orphan", report, ticks, mode, ...(mode === "sip" ? [sipReady] : [])]), { cwd: root, env: environment, timeout: 12_000 });
    assert.match(result.stdout, /ready pid=/);
    const orphan = JSON.parse(fs.readFileSync(report, "utf8")) as Identity;
    assert.equal(orphan.ppid, 1); assert.equal(orphan.sid, orphan.pid, "raw setsid must really escape the original group/session");
    assert.equal(alive(orphan), false, "supervisor must not return while a detached orphan is alive");
    if (mode === "sip") assert.equal(fs.readFileSync(sipReady, "utf8"), "sip-ready");
    else { const before = fs.statSync(ticks).size; await delay(200); assert.equal(fs.statSync(ticks).size, before, "every unobserved churning descendant must stop writing"); }
    assert.equal(alive(hostIdentity), true); assert.equal(alive(otherIdentity), true, "a different kernel marker must be protected from cleanup");
    assert.equal(fs.readdirSync(profiles).filter(name => name.startsWith(".scope-")).length, 1, "only the still-running other job's marker remains");
  }
  const python = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { env: environment, encoding: "utf8" }).trim();
  const ptyProof = String.raw`
import errno,fcntl,json,os,pty,re,select,subprocess,sys,termios,time
launcher,fixture,hook,profile_a,broker_a,profile_b,broker_b,root=sys.argv[1:]
report=os.path.join(root,'tty-report.js');ticks=os.path.join(root,'tty-ticks.js');trigger=os.path.join(root,'tty-go.js')
def session():
    os.setsid();fcntl.ioctl(0,termios.TIOCSCTTY,0)
def arguments(profile,broker,id,command):
    return [launcher,'--profile',profile,'--broker',broker,'--hook',hook,'--network-id',id,'--announce-ready','--']+command
def read_until(master,process,needle):
    output=b'';deadline=time.monotonic()+8
    while needle not in output:
        if time.monotonic()>deadline: raise AssertionError('PTY timeout '+output.decode(errors='replace'))
        readable,_,_=select.select([master],[],[],0.05)
        if readable:
            try:data=os.read(master,65536)
            except OSError as e:
                if e.errno==errno.EIO:data=b''
                else:raise
            output+=data
            if not data and process.poll() is not None:raise AssertionError(output)
    return output
master,slave=pty.openpty();old_path=os.ttyname(slave)
child=subprocess.Popen(arguments(profile_a,broker_a,'a',[fixture,'orphan',report,ticks,'tty',trigger,old_path]),stdin=slave,stdout=slave,stderr=slave,preexec_fn=session,cwd=root)
os.close(slave)
try:
    child.wait(timeout=10);assert child.returncode==0
finally:
    if child.poll() is None:child.kill();child.wait()
    os.close(master)
master,slave=pty.openpty();assert os.ttyname(slave)==old_path,(old_path,os.ttyname(slave))
settings=termios.tcgetattr(slave);settings[3]&=~termios.ECHO;termios.tcsetattr(slave,termios.TCSANOW,settings)
next_child=subprocess.Popen(arguments(profile_b,broker_b,'b',[fixture,'input']),stdin=slave,stdout=slave,stderr=slave,preexec_fn=session,cwd=root)
os.close(slave)
try:
    output=read_until(master,next_child,b'ready pid=')
    open(trigger,'w').write('try old ioctl/path now')
    time.sleep(0.15);os.write(master,b'clean\n')
    output+=read_until(master,next_child,b'INPUT=clean')
    next_child.wait(timeout=8);assert next_child.returncode==0
    assert b'ESCAPED_TTY' not in output,output
    print('tty-reuse-ok')
finally:
    if next_child.poll() is None:next_child.kill();next_child.wait()
    os.close(master)
`;
  const tty = await run(python, ["-c", ptyProof, launcher, fixture, hook, a.policy, a.endpoint, b.policy, b.endpoint, root],
    { env: environment, cwd: root, timeout: 25_000 });
  assert.equal(tty.stdout.trim(), "tty-reuse-ok");
  const ttyOrphan = JSON.parse(fs.readFileSync(path.join(root, "tty-report.js"), "utf8")) as Identity;
  assert.equal(alive(ttyOrphan), false);
  assert.equal(alive(hostIdentity), true); assert.equal(alive(otherIdentity), true);
});
