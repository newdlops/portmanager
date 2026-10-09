#!/usr/bin/env python3
"""Compare real native host helpers against direct TCP; retain every sample."""
import argparse
import sys
import hashlib
import json
import os
from pathlib import Path
import queue
import random
import signal
import socket
import statistics
import subprocess
import threading
import time
import uuid

# The terminal launching this script may itself carry PM's preload. Cleaning
# only subprocess environments leaves this Python probe hooked; a probe bind
# can then allocate a logical route instead of reserving the raw endpoint.
# Re-exec before any socket work so the controller and children are unhooked.
if os.environ.get('PM_BENCH_CLEAN_ENV') != '1':
    cleaned = dict(os.environ)
    for key in list(cleaned):
        if key.startswith(('PORT_MANAGER_', 'NEWDLOPS_PM_', 'DYLD_', 'PM_TEST_')) or key in ('LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'ENV'):
            cleaned.pop(key, None)
    cleaned['PORT_MANAGER_HOOK'] = '0'
    cleaned['PM_BENCH_CLEAN_ENV'] = '1'
    os.environ['PORT_MANAGER_HOOK'] = '0'
    os.execve(sys.executable, [sys.executable, *sys.argv], cleaned)

parser = argparse.ArgumentParser()
parser.add_argument('--directory', type=Path, required=True)
parser.add_argument('--seconds', type=int, default=3)
parser.add_argument('--rounds', type=int, default=5)
options = parser.parse_args()
assert 1 <= options.seconds <= 15 and 1 <= options.rounds <= 10
directory = options.directory.resolve()
run_id = uuid.uuid4().hex
environment = dict(os.environ)
for key in list(environment):
    if key.startswith(('PORT_MANAGER_', 'NEWDLOPS_PM_', 'DYLD_', 'PM_TEST_')) or key in ('LD_PRELOAD', 'NODE_OPTIONS', 'BASH_ENV', 'ENV'):
        environment.pop(key, None)
environment['PORT_MANAGER_PROXY_MAX_CONNECTIONS'] = '32'
environment['PORT_MANAGER_PROXY_MAX_DNS_JOBS'] = '2'
processes = []

def start(command):
    child_environment = dict(environment)
    if os.environ.get('PM_BENCH_TRACE') == '1' and Path(command[0]).name == 'host-after':
        child_environment['PORT_MANAGER_DEV_LOG'] = str(directory / 'pump-finish.log')
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               text=True, env=child_environment, start_new_session=True)
    processes.append(process)
    return process

def read_ready(process, handler=None):
    messages = queue.Queue()
    def drain():
        for line in process.stdout:
            if line.startswith('READY'):
                messages.put(line.strip())
            elif handler:
                handler(line.strip())
    threading.Thread(target=drain, daemon=True).start()
    try:
        return messages.get(timeout=5)
    except queue.Empty:
        status = process.poll()
        error = process.stderr.read() if status is not None else 'process still running'
        raise RuntimeError(f'No READY from pid={process.pid}, exit={status}: {error}')

def counters(process):
    line = subprocess.check_output(['/bin/ps', '-p', str(process.pid), '-o', 'rss=,time='], text=True).strip().split()
    seconds = 0.0
    for part in line[1].split(':'):
        seconds = seconds * 60 + float(part)
    return {'rssKiB': int(line[0]), 'cpuSeconds': seconds}

try:
    backend = start([str(directory / 'transfer-bench'), 'server'])
    backend_port = int(read_ready(backend).split()[1])
    endpoints = {'direct': backend_port}
    helpers = {}
    for label in ('before', 'after'):
        # Fixed-range probes avoid racing this benchmark's ephemeral clients.
        probe = socket.socket()
        for port in random.sample(range(10000, 30000), 1000):
            try:
                probe.bind(('127.0.0.1', port))
                break
            except OSError:
                continue
        else:
            raise RuntimeError('No free benchmark endpoint')
        probe.close()
        helper = start([str(directory / ('host-' + label)), '127.0.0.1', str(port)])
        def route(line, helper=helper):
            fields = line.split('\t')
            if fields[0] == 'CONNECT':
                helper.stdin.write('ROUTE\t' + fields[1] + '\t127.0.0.1\t' + str(backend_port) + '\n')
                helper.stdin.flush()
        read_ready(helper, route)
        endpoints[label] = port
        helpers[label] = helper

    samples = []
    for round_index in range(options.rounds):
        order = list(endpoints)
        random.Random(100 + round_index).shuffle(order)
        for connections in (1, 8):
            for label in order:
                before = counters(helpers[label]) if label in helpers else None
                command = [str(directory / 'transfer-bench'), 'bulk', str(endpoints[label]), str(connections), str(options.seconds)]
                completed = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=options.seconds + 20)
                if completed.returncode and (label != 'before' or completed.returncode != 7):
                    failure = {'command': command, 'exitCode': completed.returncode,
                               'stdout': completed.stdout, 'stderr': completed.stderr,
                               'controllerPreloadPresent': 'DYLD_INSERT_LIBRARIES' in os.environ,
                               'controllerScopePresent': 'PORT_MANAGER_NETWORK_ID' in os.environ}
                    (directory / 'failure.json').write_text(json.dumps(failure, indent=2) + '\n')
                    raise RuntimeError(json.dumps(failure))
                measurement = json.loads(completed.stdout)
                if label != 'before':
                    assert measurement['failures'] == 0
                after = counters(helpers[label]) if label in helpers else None
                sample = {'runId': run_id, 'round': round_index + 1, 'path': label, **measurement}
                if after:
                    sample.update({'helperCpuPercent': 100 * (after['cpuSeconds'] - before['cpuSeconds']) / measurement['seconds'],
                                   'helperRssKiB': after['rssKiB']})
                samples.append(sample)
                with (directory / 'samples.jsonl').open('a') as journal:
                    journal.write(json.dumps(sample) + '\n')
                print(json.dumps(sample), flush=True)
                time.sleep(0.05)
        for label in order:
            result = subprocess.run([str(directory / 'transfer-bench'), 'latency', str(endpoints[label])],
                                    env=environment, capture_output=True, text=True, timeout=15, check=True)
            sample = {'runId': run_id, 'round': round_index + 1, 'path': label, 'kind': 'latency', **json.loads(result.stdout)}
            samples.append(sample)
            with (directory / 'samples.jsonl').open('a') as journal:
                journal.write(json.dumps(sample) + '\n')
        (directory / 'samples.json').write_text(json.dumps(samples, indent=2) + '\n')

    summary = {}
    for label in endpoints:
        summary[label] = {}
        for connections in (1, 8):
            rows = [row for row in samples if row['path'] == label and row.get('connections') == connections]
            summary[label][str(connections)] = {'medianPayloadMiBps': statistics.median(row['payloadMiBps'] for row in rows),
                'minPayloadMiBps': min(row['payloadMiBps'] for row in rows), 'maxPayloadMiBps': max(row['payloadMiBps'] for row in rows),
                'failedSamples': sum(row['failures'] != 0 for row in rows),
                'medianPayloadMiBpsIsValidComparison': all(row['failures'] == 0 for row in rows)}
            if label in helpers:
                summary[label][str(connections)]['medianHelperCpuPercent'] = statistics.median(row['helperCpuPercent'] for row in rows)
        rows = [row for row in samples if row['path'] == label and row.get('kind') == 'latency']
        summary[label]['latency'] = {metric: statistics.median(row[metric] for row in rows) for metric in ('p50Us', 'p95Us', 'p99Us')}
    baseline_valid = all(row.get('failures', 0) == 0 for row in samples if row['path'] == 'before')
    result = {'runId': run_id, 'status': 'candidate-and-direct-passed', 'baselineIntegrityPassed': baseline_valid,
        'scope': 'real loopback TCP echo, direct versus standalone production native host helper; no installed extension, hook or daemon',
        'payloadRateDefinition': 'returned and byte-checked payload MiB/s; echo sends the same bytes in both directions',
        'secondsPerSample': options.seconds, 'rounds': options.rounds, 'connections': [1, 8],
        'source': 'same route/64KiB buffer/32 worker cap; caller-supplied forwarding variants with exact sources and flags in build-inputs.json',
        'binaries': {label: hashlib.sha256((directory / ('host-' + label)).read_bytes()).hexdigest() for label in helpers},
        'summary': summary, 'samples': samples}
    (directory / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'summary': summary}), flush=True)
finally:
    for process in processes:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
    (directory / 'cleanup.json').write_text(json.dumps({'runId': run_id, 'ownedPids': [process.pid for process in processes],
        'allExited': all(process.poll() is not None for process in processes)}, indent=2) + '\n')
