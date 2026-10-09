import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { promisify } from "node:util";
import { buildMacosNetworkSandboxProfile } from "../../src/platform/process/macos-network-sandbox";
import { networkNamespacePaths } from "../../src/platform/process/network-file-scaffold";

const run = promisify(execFile);

test("protected launcher confirms kernel policy, drops inherited authority and supervises host runtimes", {
  skip: process.platform !== "darwin", timeout: 60_000,
}, async context => {
  const source = path.resolve(__dirname, "../../..");
  const root = fs.mkdtempSync("/private/tmp/pm-launch-");
  const children: ChildProcess[] = [];
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket); socket.once("close", () => connections.delete(socket));
    let input = "";
    socket.on("error", () => {}); socket.on("data", bytes => {
      input += bytes.toString();
      if (input.length < 7) return;
      assert.equal(input, "fixture"); socket.end("ok");
    });
  });
  const log = path.join(root, "launcher.log");
  context.after(async () => {
    if (fs.existsSync(log)) context.diagnostic(fs.readFileSync(log, "utf8"));
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, "exit"); child.kill("SIGTERM");
      await Promise.race([exited, delay(3000)]);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited; }
    }
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const runtime = path.join(root, ".portmanager/runtime");
  const security = path.join(root, ".portmanager/security");
  const profiles = path.join(security, "profiles"), sockets = path.join(security, "sockets");
  for (const directory of [runtime, profiles, sockets]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const launcherPath = path.join(runtime, "launch"), brokerPath = path.join(runtime, "broker"), hookPath = path.join(runtime, "hook.dylib");
  for (const [input, output] of [["native/network-launcher/portmanager_network_launch.c", launcherPath],
    ["native/network-broker/portmanager_network_broker.c", brokerPath]]) {
    const dependencies = [path.join(source, "native/agent/portmanager_agent_json.c")];
    execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "-O2", path.join(source, input), ...dependencies,
      path.join(source, "native/shared/pm_dev_log.c"), "-o", output]);
  }
  execFileSync("cc", ["-Wall", "-Wextra", "-O2", "-dynamiclib", path.join(source, "native/hook/portmanager_hook.c"),
    path.join(source, "native/shared/pm_dev_log.c"), "-o", hookPath]);
  const socketPath = path.join(sockets, "a.sock");
  const environment: NodeJS.ProcessEnv = { ...process.env, PORT_MANAGER_DEV_LOG: log,
    PORT_MANAGER_NETWORK_ID: "network-b", PORT_MANAGER_AGENT_NETWORK_TOKEN: "f".repeat(64),
    PORT_MANAGER_HOOK_DISABLED: "1", BASH_ENV: path.join(root, "untrusted-startup.sh") };
  delete environment.DYLD_INSERT_LIBRARIES; delete environment.LD_PRELOAD;
  const startupMarker = path.join(root, "startup-executed");
  fs.writeFileSync(environment.BASH_ENV!, `touch ${startupMarker}\n`);
  const broker = spawn(brokerPath, ["--socket", socketPath, "--network-id", "network-a", "--loopback-host", "127.0.0.1"],
    { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.push(broker);
  assert.match((await once(broker.stdout!, "data"))[0].toString(), /ready/);
  const own = networkNamespacePaths(root, "network-a"), other = networkNamespacePaths(root, "network-b");
  for (const namespace of [own, other]) fs.mkdirSync(namespace.filesDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(own.envFilePath, "APP_VARIANT=a\n", { mode: 0o600 });
  fs.writeFileSync(other.envFilePath, "APP_VARIANT=b\n", { mode: 0o600 });
  const profile = buildMacosNetworkSandboxProfile({ networkId: "network-a", namespaceDirectories: [own.directory],
    sharedWorkspaceDirectories: [root], agentSocketPath: socketPath });
  const profilePath = path.join(profiles, "a.sb");
  fs.writeFileSync(profilePath, profile, { mode: 0o600 });
  const privateParent = path.join(security, "synthetic-parent.key");
  fs.writeFileSync(privateParent, "synthetic-parent-authority", { mode: 0o600 });
  const privateIdentity = fs.statSync(privateParent);
  const shared = path.join(root, "shared-source.txt"); fs.writeFileSync(shared, "original");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  const args = (policy: string, command: string[]) => ["--profile", policy, "--broker", socketPath,
    "--hook", hookPath, "--network-id", "network-a", "--announce-ready", "--", ...command];
  const script = `
    const assert=require('assert/strict'), fs=require('fs'), net=require('net');
    const variant=process.env.APP_VARIANT;
    assert.equal(process.env.PORT_MANAGER_NETWORK_ID,'network-a');
    assert.equal(process.env.PORT_MANAGER_AGENT_NETWORK_TOKEN,undefined);
    assert.equal(process.env.BASH_ENV,undefined);
    let inherited=false;
    for(let fd=3;fd<64;fd++){try{const s=fs.fstatSync(fd);if(s.dev===${privateIdentity.dev}&&s.ino===${privateIdentity.ino})inherited=true;}catch{}}
    assert.equal(inherited,false);
    process.env.PORT_MANAGER_NETWORK_ID='network-b'; process.env.PORT_MANAGER_HOOK_DISABLED='1';
    assert.throws(()=>fs.readFileSync(${JSON.stringify(other.envFilePath)}),e=>e.code==='EPERM'||e.code==='EACCES');
    assert.throws(()=>fs.readFileSync(${JSON.stringify(privateParent)}),e=>e.code==='EPERM'||e.code==='EACCES');
    fs.writeFileSync(${JSON.stringify(shared)},'changed');
    fs.writeFileSync(${JSON.stringify(path.join(own.filesDirectory, "state.pid"))},'own');
    const s=net.connect(${port},'127.0.0.1',()=>s.write('fixture'));
    s.on('error',e=>{console.error(e.code);process.exitCode=3});
    s.on('data',bytes=>{assert.equal(bytes.toString(),'ok');console.log(JSON.stringify({pid:process.pid,variant,inherited}));s.end()});
  `;
  const inherited = fs.openSync(privateParent, "r");
  let launched: ChildProcess;
  try {
    launched = spawn(launcherPath, args(profilePath, [process.execPath, "-e", script]),
      { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", inherited] });
  } finally { fs.closeSync(inherited); }
  children.push(launched);
  let output = "", errors = "";
  launched.stdout!.on("data", chunk => output += chunk.toString());
  launched.stderr!.on("data", chunk => errors += chunk.toString());
  const ended = await Promise.race([once(launched, "exit"), delay(12_000).then(() => { throw new Error(`launcher startup timeout; stdout=${output}; stderr=${errors}`); })]);
  assert.equal(ended[0], 0, `stdout=${output}; stderr=${errors}`);
  const ready = /ready pid=(\d+) birth=(\d+)/.exec(output);
  assert.ok(ready, output);
  const runtimeResult = JSON.parse(output.split("\n").find(line => line.startsWith("{"))!) as { pid: number; variant: string; inherited: boolean };
  assert.equal(runtimeResult.pid, Number(ready[1]), "readiness must refer to the actual fork child, not the supervisor or env PID");
  assert.equal(runtimeResult.variant, "a", "the existing per-network env hook must still apply before runtime initialization");
  assert.equal(runtimeResult.inherited, false);
  assert.equal(fs.readFileSync(shared, "utf8"), "changed");
  assert.equal(fs.readFileSync(other.envFilePath, "utf8"), "APP_VARIANT=b\n");
  assert.equal(fs.existsSync(startupMarker), false);

  // Runtime discovery happens outside the launcher. An asdf shell shim must
  // not execute the deliberately hostile BASH_ENV used for launch testing.
  const discoveryEnvironment = { ...environment };
  delete discoveryEnvironment.BASH_ENV; delete discoveryEnvironment.ENV;
  const pythonPath = execFileSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8", env: discoveryEnvironment }).trim();
  assert.equal(fs.existsSync(startupMarker), false);
  const python = await run(launcherPath, args(profilePath, [pythonPath, "-c",
    "import socket,sys; s=socket.create_connection(('127.0.0.1',int(sys.argv[1])));s.sendall(b'fixture');assert s.recv(32)==b'ok';s.close();print('python-ok')", String(port)]),
    { cwd: root, env: environment, timeout: 12_000 });
  assert.match(python.stdout, /python-ok/);

  // Exercise a real controlling PTY rather than treating piped execution as
  // terminal evidence. SIP strips preload on zsh; restore it at the actual
  // runtime exec boundary, inside the same inherited kernel policy.
  const ptyProgram = String.raw`
import errno,fcntl,json,os,pty,re,select,shlex,signal,subprocess,sys,termios,time
launcher,profile,broker,hook,node,root,port=sys.argv[1:]
master,slave=pty.openpty()
peer_master,peer_slave=pty.openpty(); peer_path=os.ttyname(peer_slave)
settings=termios.tcgetattr(slave); settings[3] &= ~termios.ECHO; termios.tcsetattr(slave,termios.TCSANOW,settings)
def session():
    os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
args=[launcher,'--profile',profile,'--broker',broker,'--hook',hook,'--network-id','network-a','--announce-ready','--','/bin/zsh','-f','-i']
child=subprocess.Popen(args,cwd=root,stdin=slave,stdout=slave,stderr=slave,preexec_fn=session,env=os.environ.copy())
os.close(slave); output=b''
def until(marker):
    global output
    deadline=time.monotonic()+10
    while (marker not in output if isinstance(marker,bytes) else marker.search(output) is None):
        if time.monotonic()>=deadline: raise AssertionError('PTY timed out: '+output.decode(errors='replace'))
        ready,_,_=select.select([master],[],[],0.1)
        if ready:
            try: data=os.read(master,65536)
            except OSError as error:
                if error.errno==errno.EIO: data=b''
                else: raise
            if not data: raise AssertionError('PTY ended: '+output.decode(errors='replace'))
            output+=data
try:
    until(b'ready pid=')
    program="const a=require('assert/strict'),f=require('fs'),n=require('net');a.throws(()=>f.openSync(process.argv[2],f.constants.O_RDONLY|f.constants.O_NONBLOCK|f.constants.O_NOCTTY),e=>e.code==='EPERM'||e.code==='EACCES');const s=n.connect(Number(process.argv[1]),'127.0.0.1',()=>s.write('fixture'));s.on('data',b=>{if(b.toString()!=='ok')process.exitCode=2;console.log('__PTY_RESULT__'+JSON.stringify({tty:process.stdin.isTTY,variant:process.env.APP_VARIANT}));s.end()});s.on('error',e=>{console.error(e.code);process.exitCode=3});"
    command='/usr/bin/env '+shlex.quote('DYLD_INSERT_LIBRARIES='+hook)+' '+shlex.quote(node)+' -e '+shlex.quote(program)+' '+port+' '+shlex.quote(peer_path)
    os.write(master,(command+'\n').encode())
    result_pattern=re.compile(rb'__PTY_RESULT__(\{[^\r\n]*\})'); until(result_pattern)
    result=result_pattern.search(output)
    assert result,output.decode(errors='replace')
    state=json.loads(result.group(1)); assert state['tty'] is True and state['variant']=='a',state
    assert b"can't set tty pgrp" not in output,output.decode(errors='replace')
    os.write(master,b"/bin/sleep 30 & job=$!; kill $job; wait $job; print '__PTY_JOB_DONE__'\n"); until(b'__PTY_JOB_DONE__\r\n')
    assert b'operation not permitted' not in output.lower(),output.decode(errors='replace')
    os.write(master,b'exit\n')
    end_deadline=time.monotonic()+5
    while child.poll() is None:
        if time.monotonic()>=end_deadline: raise AssertionError('PTY did not exit: '+output.decode(errors='replace'))
        readable,_,_=select.select([master],[],[],0.05)
        if readable:
            try: output+=os.read(master,65536)
            except OSError as error:
                if error.errno!=errno.EIO: raise
    assert child.returncode==0,output.decode(errors='replace')
    print('pty-ok')
finally:
    if child.poll() is None:
        child.terminate()
        try: child.wait(timeout=3)
        except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=3)
    os.close(master); os.close(peer_master); os.close(peer_slave)
`;
  const pty = await run(pythonPath, ["-c", ptyProgram, launcherPath, profilePath, socketPath, hookPath, process.execPath, root, String(port)],
    { cwd: root, env: discoveryEnvironment, timeout: 20_000 });
  assert.equal(pty.stdout.trim(), "pty-ok");

  const holding = spawn(launcherPath, args(profilePath, [process.execPath, "-e",
    "process.on('SIGTERM',()=>{}); console.log('holding');setInterval(()=>{},1000);setTimeout(()=>process.exit(0),12000)"]),
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  children.push(holding);
  const holdingExit = once(holding, "exit");
  let heldOutput = "";
  holding.stdout!.on("data", chunk => heldOutput += chunk.toString());
  const startedDeadline = Date.now() + 10_000;
  while (!heldOutput.includes("holding") || !heldOutput.includes("ready pid=")) {
    assert.ok(Date.now() < startedDeadline, heldOutput);
    await delay(10);
  }
  const stoppedAt = Date.now(); holding.kill("SIGTERM");
  const stop = await Promise.race([holdingExit, delay(5000).then(() => { throw new Error("supervisor did not stop its signal-ignoring child"); })]);
  assert.equal(stop[0], 137, "termination must escalate to SIGKILL for the owned group after its grace period");
  assert.ok(Date.now() - stoppedAt < 5000);

  for (const [name, contents] of [["permissive", "(version 1)\n(allow default)\n"],
    ["direct-ip", profile + "(allow network-outbound)\n"]]) {
    const invalidProfile = path.join(profiles, `${name}.sb`); fs.writeFileSync(invalidProfile, contents, { mode: 0o600 });
    await assert.rejects(run(launcherPath, args(invalidProfile, ["/usr/bin/touch", startupMarker]),
      { cwd: root, env: environment, timeout: 12_000 }), error => (error as { code?: number; stdout?: string }).code === 125 &&
        !/ready pid=/.test((error as { stdout?: string }).stdout ?? ""));
    assert.equal(fs.existsSync(startupMarker), false, "failed policy must not execute the program or fall back");
  }
  await assert.rejects(run(launcherPath, args(profilePath, [path.join(root, "missing-program")]),
    { cwd: root, env: environment, timeout: 12_000 }), error => (error as { code?: number; stdout?: string }).code === 125 &&
      !/ready pid=/.test((error as { stdout?: string }).stdout ?? ""), "exec failure after policy confirmation must not announce readiness");
  const linked = path.join(profiles, "linked.sb"); fs.symlinkSync(profilePath, linked);
  await assert.rejects(run(launcherPath, args(linked, ["/usr/bin/touch", startupMarker]),
    { cwd: root, env: environment, timeout: 3000 }), error => (error as { code?: number }).code === 125);
});
