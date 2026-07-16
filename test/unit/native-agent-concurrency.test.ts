import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  getNetworkRouteTablePath,
  getRouteTablePathForComposeClaimPort,
  getRouteTablePathForLogicalPort,
} from "../../src/agent/route-table";
import { buildNodeRuntimeEnvironment } from "../../src/platform/process/node-runtime";

/**
 * Black-box concurrency coverage for the native daemon.
 *
 * The hook opens short-lived sockets that expect a response frame as the first
 * useful message. A long-lived extension socket receives async snapshots at the
 * same time. This test keeps both patterns active while many route allocations
 * arrive together, which catches response/event interleaving and backlog issues.
 */

const projectRoot = path.resolve(__dirname, "../../..");
const nativeAgentPath = path.join(projectRoot, "media", "native", "portmanager_agent");

test("native agent caches listener scans for concurrent snapshot readers", () => {
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const agentSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.c"), "utf8");
  const probeSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_probe.c"), "utf8");
  const hookSource = fs.readFileSync(path.join(projectRoot, "native", "hook", "portmanager_hook.c"), "utf8");
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const snapshotStart = source.indexOf("int pm_state_snapshot");
  const snapshotEnd = source.indexOf("int pm_state_refresh_snapshot", snapshotStart);
  const snapshotBody = source.slice(snapshotStart, snapshotEnd);
  const cachedSnapshotStart = source.indexOf("int pm_state_cached_snapshot");
  const cachedSnapshotEnd = source.indexOf("int pm_state_daemon_status", cachedSnapshotStart);
  const cachedSnapshotBody = source.slice(cachedSnapshotStart, cachedSnapshotEnd);
  const cleanupStart = source.indexOf("static int pm_cleanup_pending");
  const cleanupEnd = source.indexOf("static pm_route *pm_find_active_route", cleanupStart);
  const cleanupBody = source.slice(cleanupStart, cleanupEnd);
  const eventSnapshotStart = agentSource.indexOf("static int pm_build_snapshot_event");
  const eventSnapshotEnd = agentSource.indexOf("static int pm_broadcast_snapshot", eventSnapshotStart);
  const eventSnapshotBody = agentSource.slice(eventSnapshotStart, eventSnapshotEnd);
  const allocationStart = source.indexOf("int pm_state_allocate_route");
  const allocationEnd = source.indexOf("static void pm_remove_pending_allocation", allocationStart);
  const allocationBody = source.slice(allocationStart, allocationEnd);
  const reservationStart = source.indexOf("static int pm_actual_port_reserved");
  const reservationEnd = source.indexOf("static int pm_port_available", reservationStart);
  const reservationBody = source.slice(reservationStart, reservationEnd);
  const pendingEndpointStart = source.indexOf("static pm_pending_route *pm_find_pending_endpoint");
  const pendingEndpointEnd = source.indexOf("static pm_pending_route *pm_find_pending_allocation", pendingEndpointStart);
  const pendingEndpointBody = source.slice(pendingEndpointStart, pendingEndpointEnd);
  const registrationStart = source.indexOf("int pm_state_register_process");
  const registrationEnd = source.indexOf("int pm_state_release_allocation", registrationStart);
  const registrationBody = source.slice(registrationStart, registrationEnd);

  assert.equal(header.includes("PM_LISTENER_SCAN_CACHE_SECONDS 300"), true);
  assert.equal(header.includes("PORTMANAGER_PACKAGE_VERSION"), true);
  assert.equal(header.includes("char version[PM_SMALL];"), true);
  assert.equal(header.includes("endpoint security agents"), true);
  assert.equal(header.includes("pm_listener *listener_cache_items;"), true);
  assert.equal(header.includes("time_t next_pending_expiry_scan_at;"), true);
  assert.equal(header.includes("unsigned int *pending_endpoint_hints;"), true);
  assert.equal(header.includes("unsigned int *pending_actual_port_hints;"), true);
  assert.equal(header.includes("int pm_state_cached_snapshot"), true);
  assert.equal(agentSource.includes("PM_LISTENER_POLL_INTERVAL_SECONDS 300"), true);
  assert.equal(agentSource.includes("PM_SNAPSHOT_BROADCAST_IDLE_MS 40"), true);
  assert.equal(agentSource.includes("PM_SNAPSHOT_BROADCAST_MAX_DELAY_MS 250"), true);
  assert.equal(agentSource.includes("PM_ACCEPT_BUDGET_PER_TURN 512"), true);
  assert.equal(agentSource.includes("PM_CLIENT_READ_BUDGET_PER_TURN 512"), true);
  assert.equal(agentSource.includes("PM_CLIENT_RESPONSE_WRITE_BUDGET_MS 100"), true);
  assert.equal(agentSource.includes("PM_CONTROL_WRITE_BUDGET_MS 100"), true);
  assert.equal(agentSource.includes("PM_SNAPSHOT_BROADCAST_WRITE_BUDGET_MS 100"), true);
  assert.equal(agentSource.includes("PM_SNAPSHOT_BROADCAST_START_MAX_DELAY_MS"), true);
  assert.equal(agentSource.includes("snapshot_dirty_since_ms"), true);
  assert.equal(agentSource.includes("size_t client_scan_cursor = 0;"), true);
  assert.equal(agentSource.includes("pm_client_has_complete_frame(&clients[index])"), true);
  assert.equal(agentSource.includes("pm_process_client_buffer(client, state, snapshot_dirty, route_tables_dirty, 1)"), true);
  assert.equal(agentSource.includes("static int pm_write_event_progress("), true);
  assert.equal(agentSource.includes("ready = poll(write_fds"), true);
  assert.equal(agentSource.includes("PM_LISTEN_BACKLOG 16384"), true);
  assert.equal(agentSource.includes("static int pm_socket_has_live_server"), true);
  assert.equal(agentSource.includes("Port Manager agent is already listening"), true);
  assert.equal(probeSource.includes("int pm_probe_daemon"), true);
  assert.equal(probeSource.includes("int pm_lock_is_stale"), true);
  assert.equal(probeSource.includes("CLOCK_MONOTONIC"), true);
  assert.equal(probeSource.includes('strcmp(argv[index], "--probe")'), true);
  assert.equal(probeSource.includes("int saw_newline = 0"), true);
  assert.equal(probeSource.includes("pm_json_get_string(payload, \"agentMainPath\""), true);
  assert.equal(probeSource.includes("pm_stat_mtime_is_newer_than_milliseconds(&expected_stat, started_at_ms + 1000)"), true);
  assert.equal(probeSource.includes("(size_t)written >= out_size"), true);
  assert.equal(agentSource.includes("Only unlink after"), true);
  assert.equal(agentSource.includes("bind_errno != EADDRINUSE || pm_socket_has_live_server"), true);
  assert.equal(agentSource.includes("PM_CLIENT_BUFFER_INITIAL 2048"), true);
  assert.equal(agentSource.includes("PM_CLIENT_BUFFER_MAX 262144"), true);
  assert.equal(agentSource.includes("#include <poll.h>"), true);
  assert.equal(agentSource.includes("ready = poll("), true);
  assert.equal(agentSource.includes("state->route_tables_dirty = 1;"), true);
  assert.equal(hookSource.includes("PM_MAX_ROUTES"), false);
  assert.equal(hookSource.includes("PM_ROUTE_MAPPING_INITIAL_CAPACITY"), true);
  assert.equal(hookSource.includes("PM_ROUTE_MAPPING_MAX_CAPACITY 65535"), true);
  assert.equal(hookSource.includes("PM_ROUTE_FILE_CACHE_MAX_CAPACITY 65535"), true);
  assert.equal(hookSource.includes("pm_ensure_memory_route_capacity"), true);
  assert.equal(hookSource.includes("\\\"compactResponse\\\":1"), true);
  assert.equal(hookSource.includes("PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE"), true);
  assert.equal(hookSource.includes('PM_LOOPBACK_ADDRESS_ONLY_MODE "loopback-address-only"'), true);
  assert.equal(hookSource.includes('\\\"experimentalRouteOwnershipMode\\\":\\\"%s\\\"'), true);
  assert.equal(hookSource.includes("\\\"terminalSessionId\\\":\\\""), true);
  assert.equal(source.includes("static int pm_scan_lsof_cached"), true);
  assert.equal(source.includes("static int pm_write_route_table_file_if_changed"), true);
  assert.equal(source.includes("PM_ROUTE_TABLE_WRITE_LOCK_BACKGROUND_ATTEMPTS"), false);
  assert.equal(source.includes("pm_route_table_generation_is_newer_for_publish"), true);
  assert.equal(source.includes("static void pm_mark_route_tables_dirty"), true);
  assert.equal(source.includes('pm_copy(state->version, sizeof(state->version), PORTMANAGER_PACKAGE_VERSION)'), true);
  assert.equal(source.includes('pm_buffer_append(payload, ",\\"version\\":")'), true);
  assert.equal(source.includes("writing one endpoint file before every response"), true);
  assert.equal(source.includes("defer every registration source to the coalesced flush"), true);
  assert.equal(source.includes("pm_process_route_owner_matches_release"), true);
  assert.equal(source.includes("pm_scoped_route_ownership_mode(input->experimental_route_ownership_mode)"), true);
  assert.equal(source.includes("pm_loopback_address_only_mode(experimental_route_ownership_mode)"), true);
  assert.equal(source.includes('pm_buffer_append(buffer, ",\\\"terminalSessionId\\\":")'), true);
  assert.equal(source.includes("%s.tmp.%ld.%lu"), true);
  assert.equal(source.includes("pm_write_route_entry_table"), false);
  assert.equal(source.includes("pm_route_table_signature_for_path"), true);
  assert.equal(source.includes("pm_state_needs_external_listener_fresh_scan(state)"), true);
  assert.equal(source.includes("pm_listener_cache_invalidate(state);"), true);
  assert.equal(snapshotBody.includes("listener_scan_fresh &&"), true);
  assert.equal(snapshotBody.includes("listener_scan_result = pm_scan_lsof_cached("), true);
  assert.equal(snapshotBody.includes("&listeners,"), true);
  assert.notEqual(cachedSnapshotStart, -1);
  assert.equal(cachedSnapshotBody.includes("pm_listener_list_copy(&listeners, state->listener_cache_items"), true);
  assert.equal(cachedSnapshotBody.includes("pm_append_snapshot_from_listeners"), true);
  assert.equal(cachedSnapshotBody.includes("state->listener_cache_updated_at[0] != '\\0'"), true);
  assert.equal(source.includes("if (!synthesize_detected_processes)"), true);
  assert.equal(cachedSnapshotBody.includes("pm_cleanup_pending"), false);
  assert.equal(cachedSnapshotBody.includes("pm_scan_lsof"), false);
  assert.equal(eventSnapshotBody.includes("pm_state_cached_snapshot"), true);
  assert.equal(eventSnapshotBody.includes("pm_state_snapshot("), false);
  assert.notEqual(cleanupStart, -1);
  assert.equal(cleanupBody.includes("state->next_pending_expiry_scan_at > now"), true);
  assert.equal(cleanupBody.includes("pm_note_pending_expiry"), true);
  assert.equal(source.includes("static void pm_remember_pending_route_hints"), true);
  assert.equal(source.includes("calloc(PM_PENDING_HINT_SLOT_COUNT"), true);
  assert.equal(source.includes("free(state->pending_endpoint_hints);"), true);
  assert.equal(source.includes("free(state->pending_actual_port_hints);"), true);
  assert.equal(reservationBody.includes("state->pending_actual_port_hints[port]"), true);
  assert.equal(reservationBody.includes("for (size_t index = 0; index < state->pending_count; index++)"), true);
  assert.equal(pendingEndpointBody.includes("state->pending_endpoint_hints["), true);
  assert.equal(pendingEndpointBody.includes("hinted_route->logical_port == logical_port"), true);
  assert.equal(pendingEndpointBody.includes("for (size_t index = 0; index < state->pending_count; index++)"), true);
  assert.equal(allocationBody.includes("pm_remember_pending_route_hints(state, state->pending_count - 1)"), true);
  assert.equal(allocationBody.includes("pm_scan_lsof_cached(state, &listeners"), false);
  assert.equal(allocationBody.includes("listener_scan_fresh &&"), false);
  assert.equal(allocationBody.includes("pm_scan_lsof(&listeners"), false);
  assert.equal(allocationBody.includes("strcmp(input->route_direction, \"send\") == 0 && network_id[0] == '\\0'"), true);
  assert.notEqual(registrationStart, -1);
  assert.equal(registrationBody.includes("pm_listener_cache_invalidate(state)"), false);
  assert.equal(registrationBody.includes("Registration describes a listener already present"), true);
  assert.equal(source.includes("static int pm_scan_lsof_for_port"), true);
  assert.equal(source.includes("lsof -nP -iTCP:%d -sTCP:LISTEN -Fpcn"), true);
  assert.equal(source.includes("pm_scan_lsof_for_port(port, &listeners"), true);
  assert.equal(source.includes("pm_scan_lsof_for_port(input->actual_port, &listeners"), true);
});

test("native agent matches loopback listeners by host as well as port", () => {
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");

  assert.equal(source.includes("static int pm_endpoint_hosts_match"), true);
  assert.equal(source.includes("pm_is_non_default_loopback_host(normalized_route)"), true);
  assert.equal(source.includes("pm_find_listener_by_process_endpoint(&listeners, process)"), true);
  assert.equal(source.includes("pm_find_listener_by_process_pid_endpoint(listeners, process)"), true);
  assert.equal(source.includes("pm_find_listener_for_port_host(input->requested_port, input->host"), true);
  assert.equal(source.includes("pm_endpoint_hosts_match(listener->local_address, process->host)"), true);
  assert.equal(source.includes("pm_find_listener_by_port("), false);
});

test("native agent route tables carry TTL and refresh unchanged files", () => {
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const agentSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.c"), "utf8");
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const writeStart = source.indexOf("static int pm_write_route_table_file(");
  const writeEnd = source.indexOf("static int pm_build_route_table_signature", writeStart);
  const writeBody = source.slice(writeStart, writeEnd);
  const unchangedStart = source.indexOf("static int pm_write_route_table_file_if_changed");
  const unchangedEnd = source.indexOf("static int pm_route_table_generation_is_newer_for_publish", unchangedStart);
  const unchangedBody = source.slice(unchangedStart, unchangedEnd);

  assert.equal(source.includes('PM_ROUTE_TABLE_TTL_SECONDS_ENV "PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS"'), true);
  assert.equal(source.includes("PM_DEFAULT_ROUTE_TABLE_TTL_SECONDS 15"), true);
  assert.equal(source.includes("static void pm_refresh_established_route_observations"), true);
  assert.equal(source.includes('popen("lsof -nP -iTCP -sTCP:ESTABLISHED -Fn 2>/dev/null"'), true);
  assert.equal(source.includes("PM_ESTABLISHED_ROUTE_OBSERVATION_SCAN_INTERVAL_SECONDS 2"), true);
  assert.equal(source.includes("static int pm_build_route_endpoint_index"), true);
  assert.equal(source.includes("pm_route_endpoint_index_lower_bound"), true);
  assert.equal(source.includes("pm_mark_established_endpoint_routes"), true);
  assert.equal(source.includes("static size_t pm_bidirectional_refresh_lower_bound"), true);
  assert.equal(source.includes("static int pm_build_bidirectional_endpoint_index"), true);
  assert.equal(source.includes("pm_bidirectional_endpoint_index_contains"), true);
  assert.equal(source.includes("static size_t pm_route_table_signature_lower_bound"), true);
  assert.equal(source.includes("pm_route_table_signature_index_matches"), true);
  assert.equal(source.includes("pm_string_array_binary_contains(current_entries"), true);
  assert.equal(source.includes("pm_string_array_binary_contains(current_claims"), true);
  assert.equal(source.includes("static int pm_route_table_file_fresh_for_reuse"), true);
  assert.equal(header.includes("time_t route_table_refreshed_at;"), true);
  assert.equal(header.includes("pm_state_route_table_heartbeat_due"), true);
  assert.equal(source.includes("state->route_table_refreshed_at = time(NULL);"), true);
  assert.equal(source.includes("int pm_state_route_table_heartbeat_due"), true);
  assert.equal(agentSource.includes("pm_state_route_table_heartbeat_due(state, time(NULL))"), true);
  assert.equal(agentSource.includes("route_table_flush_retry_after"), true);
  assert.notEqual(writeStart, -1);
  assert.equal(writeBody.includes('\\"expiresAtMs\\":%ld,\\"ttlMs\\":%ld'), true);
  assert.equal(writeBody.includes('\\"ttlStartsAfterFirstHandshake\\":true'), true);
  assert.equal(writeBody.includes('\\"preHandshakeLeaseMs\\":%ld'), true);
  assert.notEqual(unchangedStart, -1);
  assert.equal(unchangedBody.includes("pm_route_table_file_fresh_for_reuse(file_path, waits_for_first_handshake)"), true);
  assert.equal(unchangedBody.includes("pm_routes_can_refresh_unchanged_table(state, routes, count)"), true);
  assert.equal(source.includes("pm_route_has_bidirectional_observation(state, &routes[index])"), true);
  assert.equal(source.includes("route-table TTL is extended by daemon heartbeat writes"), true);
  assert.equal(unchangedBody.includes("pm_write_route_table_file(state, file_path, routes, count, sequence)"), true);
});

test("native agent recovers restarted hook routes from process environment", () => {
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const peerSource = fs.readFileSync(path.join(projectRoot, "native", "shared", "pm_peer_process.c"), "utf8");
  const peerHeader = fs.readFileSync(path.join(projectRoot, "native", "shared", "pm_peer_process.h"), "utf8");
  const buildScript = fs.readFileSync(path.join(projectRoot, "scripts", "build-native-hook.sh"), "utf8");
  const tsAgent = fs.readFileSync(path.join(projectRoot, "src", "agent", "port-manager-agent.ts"), "utf8");
  const inspectStart = source.indexOf("static int pm_inspect_hook_recovery_process");
  const inspectEnd = source.indexOf("static int pm_recover_untracked_hooked_listener", inspectStart);
  const inspectBody = source.slice(inspectStart, inspectEnd);
  const environmentInspectEnd = source.indexOf("static int pm_inspect_hook_recovery_command", inspectStart);
  const environmentInspectBody = source.slice(inspectStart, environmentInspectEnd);
  const activeEnvironmentStart = source.indexOf("static int pm_hook_recovery_has_active_environment");
  const activeEnvironmentEnd = source.indexOf("static int pm_process_text_first_value", activeEnvironmentStart);
  const activeEnvironmentBody = source.slice(activeEnvironmentStart, activeEnvironmentEnd);
  const recoveryStart = source.indexOf("static int pm_recover_untracked_hooked_listeners");
  const recoveryEnd = source.indexOf("static int pm_reconcile_external_processes_with_listeners", recoveryStart);
  const recoveryBody = source.slice(recoveryStart, recoveryEnd);
  const listenerRecoveryStart = source.indexOf("static int pm_recover_untracked_hooked_listener");
  const listenerRecoveryEnd = source.indexOf("static int pm_recover_untracked_hooked_listeners", listenerRecoveryStart);
  const listenerRecoveryBody = source.slice(listenerRecoveryStart, listenerRecoveryEnd);

  assert.equal(source.includes("pm_recover_untracked_hooked_listeners"), true);
  assert.equal(source.includes("pm_read_process_environment_text"), true);
  assert.equal(source.includes("pm_read_process_command_text"), true);
  assert.notEqual(inspectStart, -1);
  assert.equal(inspectBody.match(/pm_read_process_environment_text/g)?.length, 1);
  assert.equal(inspectBody.match(/pm_read_process_command_text/g)?.length, 1);
  assert.equal(environmentInspectBody.includes("pm_read_process_command_text"), false);
  assert.equal(environmentInspectBody.includes("pm_hook_recovery_has_active_environment"), true);
  assert.equal(environmentInspectBody.includes("never for an unrelated PID"), true);
  assert.equal(activeEnvironmentBody.includes('"PORT_MANAGER_HOOK_DISABLED"'), true);
  assert.equal(activeEnvironmentBody.includes('"PORT_MANAGER_LD_PRELOAD"'), true);
  assert.equal(activeEnvironmentBody.includes('strstr(value, "portmanager_hook")'), true);
  assert.equal(source.includes("pm_read_process_environment_via_ps"), true);
  assert.equal(peerHeader.includes("int pm_peer_read_environment_text"), true);
  assert.equal(peerHeader.includes("PM_PEER_ENVIRONMENT_ENTRY_SEPARATOR"), true);
  assert.equal(peerSource.includes("KERN_PROCARGS2 prefixes the environment"), true);
  assert.equal(peerSource.includes("int pm_peer_read_environment_text"), true);
  assert.equal(peerSource.includes("A leading separator identifies the exact-entry format"), true);
  assert.equal(source.includes("has_exact_entry_boundaries"), true);
  assert.equal(source.includes('"PORT_MANAGER_HOOK_DISABLED"'), true);
  assert.equal(buildScript.includes("$PEER_PROCESS_SOURCE_FILE\""), true);
  assert.equal(recoveryBody.includes("inspection.pid != listeners->items[index].pid"), true);
  assert.equal(recoveryBody.includes("memset(&inspection, 0, sizeof(inspection))"), true);
  assert.equal(recoveryBody.includes("expensive environment/command lookup for every port in that group"), true);
  assert.equal(source.includes("VITE_CLIENT_PORT"), true);
  assert.equal(source.includes("PORT_MANAGER_NETWORK_ID"), true);
  assert.equal(source.includes("NEWDLOPS_PM_NETWORK_ID"), true);
  assert.equal(source.includes("requested_port == listener->port"), true);
  assert.equal(source.includes("pm_hook_recovery_listener_matches_exported_loopback"), true);
  assert.equal(source.includes('"PORT_MANAGER_NETWORK_LOOPBACK_HOST"'), true);
  assert.equal(source.includes('"PORT_MANAGER_ACTUAL_LOOPBACK_HOST"'), true);
  assert.equal(source.includes("IN6_IS_ADDR_V4MAPPED(&ipv6)"), true);
  assert.equal(listenerRecoveryBody.includes("pm_hook_recovery_listener_matches_exported_loopback"), true);
  assert.equal(source.includes("pm_is_non_default_loopback_host(normalized_exported_host)"), true);
  assert.equal(source.includes("requested_port == listener->port && !same_port_recovery"), true);
  assert.equal(listenerRecoveryBody.includes("if (pm_inspect_hook_recovery_command(inspection))"), true);
  assert.equal(listenerRecoveryBody.includes("pm_is_hook_recovery_helper_text(command)"), true);
  assert.ok(
    listenerRecoveryBody.indexOf("pm_inspect_hook_recovery_command(inspection)") <
      listenerRecoveryBody.indexOf("pm_infer_requested_port_from_environment"),
  );
  assert.equal(source.includes("pm_remove_pending_endpoint(state, process->requested_port, network_id)"), true);
  assert.equal(header.includes("#define PM_ROUTE_TTL_SECONDS 300"), true);
  assert.equal(tsAgent.includes("const ROUTE_ALLOCATION_TTL_MS = 300_000;"), true);
});

test("native agent repair routing forces recovery and synchronous publication", () => {
  const header = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.h"), "utf8");
  const agentSource = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent.c"), "utf8");
  const source = fs.readFileSync(path.join(projectRoot, "native", "agent", "portmanager_agent_state.c"), "utf8");
  const repairStart = source.indexOf("int pm_state_repair_routing");
  const repairEnd = source.indexOf("int pm_state_reap_children", repairStart);
  const repairBody = source.slice(repairStart, repairEnd);
  const snapshotIndex = repairBody.indexOf("pm_state_snapshot_internal(state, payload, 1)");
  const clearSignaturesIndex = repairBody.indexOf("pm_route_table_signatures_clear(state)");
  const flushIndex = repairBody.indexOf("pm_state_flush_route_tables(state)");

  assert.notEqual(repairStart, -1);
  assert.equal(header.includes("int pm_state_repair_routing"), true);
  assert.equal(agentSource.includes('strcmp(request->method, "repairRoutingState") == 0'), true);
  assert.equal(agentSource.includes('strcmp(request->method, "flushRouteTables") == 0'), true);
  assert.equal(agentSource.includes('strcmp(request.method, "repairRoutingState") != 0'), true);
  assert.equal(agentSource.includes("*route_tables_dirty = 0;"), true);
  assert.ok(snapshotIndex >= 0);
  assert.equal(repairBody.includes("pm_refresh_established_route_observations(state)"), false);
  assert.ok(clearSignaturesIndex > snapshotIndex);
  assert.ok(flushIndex > snapshotIndex);
  assert.ok(flushIndex > clearSignaturesIndex);
  assert.equal(source.includes("listener_scan_result != 0 && force_fresh_listener_scan"), true);
  assert.equal(source.includes("WIFEXITED(close_status)"), true);
  assert.equal(source.includes("WEXITSTATUS(close_status) != 1"), true);
});

if (!fs.existsSync(nativeAgentPath)) {
  test("native agent serves concurrent hook-like clients while extension client receives events", { skip: "native agent binary is not built" }, () => undefined);
} else {
  test("native agent reports the package version in daemon status", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as {
      readonly version: string;
    };

    const daemon = await requestOnce<{ readonly version?: string; readonly pid: number }>(fixture.socketPath, {
      id: `daemon-status-${process.pid}`,
      method: "daemonStatus",
    });

    assert.equal(daemon.version, packageJson.version);
    assert.equal(typeof daemon.pid, "number");
  });

  test("native agent yields after one frame from a pipelined client", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const socket = await connectSocket(fixture.socketPath);
    const messages = collectSocketMessages(socket);
    context.after(() => socket.destroy());

    const shutdownId = `hook-${process.pid}-pipeline-shutdown`;
    const trailingIds = [
      `hook-${process.pid}-pipeline-after-1`,
      `hook-${process.pid}-pipeline-after-2`,
    ];
    socket.write([
      JSON.stringify({ id: shutdownId, method: "shutdownDaemon" }),
      ...trailingIds.map((id) => JSON.stringify({ id, method: "daemonStatus" })),
      "",
    ].join("\n"));

    await waitForSocketMessage(
      messages,
      (message) => isMessageWithType(message, "response") && message.id === shutdownId && message.ok === true,
      1_000,
    );
    await new Promise<void>((resolve) => {
      if (socket.destroyed) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const responseIds = messages.flatMap((message) =>
      isMessageWithType(message, "response") && typeof message.id === "string" ? [message.id] : []);
    assert.deepEqual(responseIds, [shutdownId]);
  });

  test("native agent pushes the first cached event without launching lsof", async (context) => {
    const shimDirectory = path.join(
      projectRoot,
      ".tmp",
      "native-agent-tests",
      `cached-event-${process.pid}-${Date.now().toString(36)}`,
    );
    const lsofLogPath = path.join(shimDirectory, "lsof.log");
    fs.mkdirSync(shimDirectory, { recursive: true });
    fs.writeFileSync(lsofLogPath, "");
    fs.writeFileSync(path.join(shimDirectory, "lsof"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$PM_TEST_LSOF_LOG\"",
      "sleep 2",
    ].join("\n"), { mode: 0o755 });
    context.after(async () => {
      await fs.promises.rm(shimDirectory, { recursive: true, force: true }).catch(() => undefined);
    });

    const fixture = await startNativeAgent(context, {
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      PM_TEST_LSOF_LOG: lsofLogPath,
    });
    if (fixture === undefined) {
      return;
    }

    const socket = await connectSocket(fixture.socketPath);
    const messages = collectSocketMessages(socket);
    const requestId = `extension-${process.pid}-cached-first-event`;
    context.after(() => socket.destroy());

    const startedAt = Date.now();
    socket.write(`${JSON.stringify({ id: requestId, method: "daemonStatus" })}\n`);
    await waitForSocketMessage(
      messages,
      (message) => isMessageWithType(message, "response") && message.id === requestId && message.ok === true,
      1_000,
    );
    await waitForSocketMessage(messages, (message) => isMessageWithType(message, "snapshot"), 1_000);
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 750, `cached subscription event took ${elapsedMs}ms`);
    assert.equal(fs.readFileSync(lsofLogPath, "utf8"), "");
  });

  test("native agent reports explicit repair failure when a fresh lsof scan cannot run", async (context) => {
    const shimDirectory = path.join(
      projectRoot,
      ".tmp",
      "native-agent-tests",
      `failed-repair-scan-${process.pid}-${Date.now().toString(36)}`,
    );
    fs.mkdirSync(shimDirectory, { recursive: true });
    fs.writeFileSync(path.join(shimDirectory, "lsof"), ["#!/bin/sh", "exit 127"].join("\n"), { mode: 0o755 });
    context.after(async () => {
      await fs.promises.rm(shimDirectory, { recursive: true, force: true }).catch(() => undefined);
    });

    const fixture = await startNativeAgent(context, {
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    });
    if (fixture === undefined) {
      return;
    }

    await assert.rejects(
      requestOnce(fixture.socketPath, {
        id: `extension-${process.pid}-failed-repair-scan`,
        method: "repairRoutingState",
      }),
      /fresh listener scan/,
    );
  });

  test("native agent bounds event delivery during sustained hook traffic", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const extensionSocket = await connectSocket(fixture.socketPath);
    const messages = collectSocketMessages(extensionSocket);
    const subscriptionId = `extension-${process.pid}-fair-events`;
    context.after(() => extensionSocket.destroy());
    extensionSocket.write(`${JSON.stringify({ id: subscriptionId, method: "daemonStatus" })}\n`);
    await waitForSocketMessage(
      messages,
      (message) => isMessageWithType(message, "response") && message.id === subscriptionId && message.ok === true,
      1_000,
    );
    await waitForSocketMessage(messages, (message) => isMessageWithType(message, "snapshot"), 1_000);
    messages.splice(0, messages.length);

    const chatterSocket = await connectSocket(fixture.socketPath);
    chatterSocket.on("data", () => undefined);
    let chatterSequence = 0;
    const sendChatter = (): void => {
      if (!chatterSocket.destroyed) {
        chatterSocket.write(`${JSON.stringify({
          id: `hook-${process.pid}-fairness-chatter-${chatterSequence++}`,
          method: "daemonStatus",
        })}\n`);
      }
    };
    const chatterTimer = setInterval(sendChatter, 5);
    context.after(() => {
      clearInterval(chatterTimer);
      chatterSocket.destroy();
    });
    sendChatter();

    const processName = `fairness-fixture-${process.pid}-${Date.now().toString(36)}`;
    const actualPort = await reserveUnusedTcpPort();
    const startedAt = Date.now();
    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-fairness-register`,
      method: "registerExistingProcess",
      payload: {
        pid: process.pid,
        name: processName,
        command: processName,
        cwd: projectRoot,
        requestedPort: actualPort,
        actualPort,
        host: "127.0.0.1",
        networkId: `network-fairness-${process.pid}`,
        source: "hooked",
      },
    });
    await waitForSocketMessage(messages, (message) => {
      if (!isMessageWithType(message, "snapshot")) {
        return false;
      }
      const processes = (message.payload as { readonly processes?: readonly { readonly name?: string }[] } | undefined)?.processes;
      return processes?.some((candidate) => candidate.name === processName) === true;
    }, 1_000);
    const elapsedMs = Date.now() - startedAt;

    clearInterval(chatterTimer);
    assert.ok(elapsedMs < 750, `snapshot starved behind sustained traffic for ${elapsedMs}ms`);
  });

  test("native agent does not synthesize detected processes from an invalidated listener cache", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const stoppedServer = await openTcpServer();
    const unrelatedServer = await openTcpServer();
    context.after(async () => {
      await Promise.all([closeTcpServer(stoppedServer), closeTcpServer(unrelatedServer)]);
    });
    const stoppedAddress = stoppedServer.address();
    const unrelatedAddress = unrelatedServer.address();
    if (
      stoppedAddress === null ||
      typeof stoppedAddress === "string" ||
      unrelatedAddress === null ||
      typeof unrelatedAddress === "string"
    ) {
      throw new Error("Failed to read listener-cache test ports.");
    }

    const registered = await requestOnce<{ readonly id: string }>(fixture.socketPath, {
      id: `hook-${process.pid}-cached-listener-register`,
      method: "registerExistingProcess",
      payload: {
        pid: process.pid,
        name: "cached-listener-fixture",
        command: "cached-listener-fixture",
        cwd: projectRoot,
        requestedPort: stoppedAddress.port,
        actualPort: stoppedAddress.port,
        host: "127.0.0.1",
        networkId: `network-cached-listener-${process.pid}`,
        source: "hooked",
      },
    });

    // Populate the listener cache with both the managed and unrelated sockets.
    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-cached-listener-refresh`,
      method: "refreshSnapshot",
    });

    const extensionSocket = await connectSocket(fixture.socketPath);
    const messages = collectSocketMessages(extensionSocket);
    const subscriptionId = `extension-${process.pid}-cached-listener-events`;
    context.after(() => extensionSocket.destroy());
    extensionSocket.write(`${JSON.stringify({ id: subscriptionId, method: "daemonStatus" })}\n`);
    await waitForSocketMessage(
      messages,
      (message) => isMessageWithType(message, "response") && message.id === subscriptionId && message.ok === true,
      1_000,
    );
    await waitForSocketMessage(messages, (message) => isMessageWithType(message, "snapshot"), 1_000);
    messages.splice(0, messages.length);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-cached-listener-stop`,
      method: "stopProcess",
      payload: { id: registered.id, signal: "SIGTERM" },
    });

    const event = await waitForSocketMessage(messages, (message) => {
      if (!isMessageWithType(message, "snapshot")) {
        return false;
      }
      const processes = (message.payload as {
        readonly processes?: readonly { readonly id?: string; readonly status?: string }[];
      } | undefined)?.processes;
      return processes?.some((candidate) => candidate.id === registered.id && candidate.status === "stopped") === true;
    }, 1_000) as AgentWireMessage;
    const payload = event.payload as {
      readonly processes?: readonly { readonly actualPort?: number; readonly source?: string }[];
      readonly listeners?: readonly { readonly port?: number }[];
    };

    assert.equal(
      payload.processes?.some(
        (candidate) => candidate.actualPort === stoppedAddress.port && candidate.source === "detected",
      ),
      false,
    );
    assert.equal(payload.listeners?.some((listener) => listener.port === unrelatedAddress.port), true);
  });

  test("native agent inspects process metadata once for all listeners owned by one PID", async (context) => {
    // A deliberately nonexistent pid makes the direct OS reader fail so this
    // fixture continues to cover the retained ps fallback deterministically.
    const inspectedPid = 2_000_000_000;
    const shimDirectory = path.join(
      projectRoot,
      ".tmp",
      "native-agent-tests",
      `process-inspection-${process.pid}-${Date.now().toString(36)}`,
    );
    const lsofLogPath = path.join(shimDirectory, "lsof.log");
    const psLogPath = path.join(shimDirectory, "ps.log");
    fs.mkdirSync(shimDirectory, { recursive: true });
    fs.writeFileSync(lsofLogPath, "");
    fs.writeFileSync(psLogPath, "");
    fs.writeFileSync(path.join(shimDirectory, "lsof"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$PM_TEST_LSOF_LOG\"",
      `printf 'p${inspectedPid}\\ncnode\\nn127.0.0.1:48311\\nn127.0.0.1:48312\\nn[::ffff:127.93.164.7]:48313\\n'`,
    ].join("\n"), { mode: 0o755 });
    fs.writeFileSync(path.join(shimDirectory, "ps"), [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$PM_TEST_PS_LOG\"",
      "if [ \"$1\" = eww ]; then",
      "  printf 'node PORT_MANAGER_HOOK=1 PORT_MANAGER_NETWORK_ID=network-recovery-cache PORT_MANAGER_EXPERIMENTAL_ROUTE_OWNERSHIP_MODE=loopback-address-only PORT_MANAGER_NETWORK_LOOPBACK_HOST=127.93.164.7 PWD=/tmp PORT=48310\\n'",
      "else",
      "  printf '/usr/bin/node server.js --port 48310\\n'",
      "fi",
    ].join("\n"), { mode: 0o755 });
    context.after(async () => {
      await fs.promises.rm(shimDirectory, { recursive: true, force: true }).catch(() => undefined);
    });

    const fixture = await startNativeAgent(context, {
      PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      PM_TEST_LSOF_LOG: lsofLogPath,
      PM_TEST_PS_LOG: psLogPath,
      PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "0",
    });
    if (fixture === undefined) {
      return;
    }

    const snapshot = await requestOnce<{
      readonly processes: readonly {
        readonly actualPort: number;
        readonly pid: number;
        readonly source: string;
      }[];
    }>(fixture.socketPath, {
      id: `extension-${process.pid}-pid-inspection-cache`,
      method: "listSnapshot",
    });
    const recoveredPorts = snapshot.processes
      .filter((candidate) => candidate.pid === inspectedPid && candidate.source === "hooked")
      .map((candidate) => candidate.actualPort)
      .sort((left, right) => left - right);
    const lsofCalls = fs.readFileSync(lsofLogPath, "utf8");
    const psCalls = fs.readFileSync(psLogPath, "utf8").trim().split("\n");

    assert.deepEqual(recoveredPorts, [48311, 48312, 48313]);
    assert.notEqual(lsofCalls, "");
    assert.deepEqual(psCalls, [
      `eww -p ${inspectedPid}`,
      `-o command= -p ${inspectedPid}`,
    ]);
  });

  test("native agent applies a complete registration after the client closes without reading", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8317;
    const actualPort = await reserveUnusedTcpPort();
    const networkId = `network-send-only-${process.pid}`;
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);
    const socket = await connectSocket(fixture.socketPath);

    // Let the daemon accept this idle client first. Its next poll then observes
    // the complete frame and peer close together, matching the hook's send-only
    // registration lifecycle.
    await delay(100);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      socket.once("error", onError);
      socket.write(`${JSON.stringify({
        id: `hook-${process.pid}-send-only-register`,
        method: "registerExistingProcess",
        payload: {
          pid: process.pid,
          name: "send-only-fixture",
          command: "send-only-fixture",
          cwd: projectRoot,
          requestedPort: logicalPort,
          actualPort,
          host: "127.0.0.1",
          networkId,
          source: "hooked",
        },
      })}\n`, () => {
        socket.off("error", onError);
        socket.destroy();
        resolve();
      });
    });

    const table = await waitForRouteTable(routeEntryPath, (candidate) => {
      const route = candidate.routes[0] as { readonly logicalPort?: number; readonly actualPort?: number } | undefined;
      return route?.logicalPort === logicalPort && route.actualPort === actualPort;
    });
    assert.equal(table.routes.length, 1);
  });

  test("native agent probes daemon readiness without a Node helper", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }
    const agentMainPath = path.join(projectRoot, "out", "src", "agent", "agent-main.js");
    const probeEnvironment = {
      ...process.env,
      PORT_MANAGER_HOOK_DISABLED: "1",
      PORT_MANAGER_HOOK: "0",
      DYLD_INSERT_LIBRARIES: "",
      LD_PRELOAD: "",
    };

    const matchingProbe = spawn(nativeAgentPath, [
      "--probe",
      "--socket",
      fixture.socketPath,
      "--agent-main",
      agentMainPath,
    ], { env: probeEnvironment, stdio: "ignore" });
    assert.equal(await waitForProcessExit(matchingProbe, 2_000), 0);

    const mismatchedProbe = spawn(nativeAgentPath, [
      "--probe",
      "--socket",
      fixture.socketPath,
      "--agent-main",
      `${agentMainPath}.stale`,
    ], { env: probeEnvironment, stdio: "ignore" });
    assert.notEqual(await waitForProcessExit(mismatchedProbe, 2_000), 0);
  });

  test("native agent checks stale startup locks without a Node helper", async () => {
    const lockPath = path.join(projectRoot, ".tmp", `native-agent-lock-${process.pid}-${Date.now()}`);
    fs.mkdirSync(lockPath, { recursive: true });
    try {
      const freshCheck = spawn(nativeAgentPath, ["--lock-stale", lockPath], { stdio: "ignore" });
      assert.notEqual(await waitForProcessExit(freshCheck, 2_000), 0);

      const staleTime = new Date(Date.now() - 20_000);
      fs.utimesSync(lockPath, staleTime, staleTime);
      const staleCheck = spawn(nativeAgentPath, ["--lock-stale", lockPath], { stdio: "ignore" });
      assert.equal(await waitForProcessExit(staleCheck, 2_000), 0);
    } finally {
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  });

  test("native agent rejects truncated CLI identity paths", async () => {
    const overlongPath = `/${"a".repeat(1_100)}`;
    const probe = spawn(nativeAgentPath, [
      "--probe",
      "--socket",
      "/tmp/pm-unused.sock",
      "--agent-main",
      overlongPath,
    ], { stdio: "ignore" });
    assert.notEqual(await waitForProcessExit(probe, 2_000), 0);
  });

  test("native agent bounds an unresponsive daemon probe", async (context) => {
    const socketPath = path.join(
      projectRoot,
      ".tmp",
      `native-agent-unresponsive-${process.pid}-${Date.now()}.sock`,
    );
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    const acceptedSockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      acceptedSockets.add(socket);
      socket.on("close", () => acceptedSockets.delete(socket));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Unix sockets are not available in this sandbox");
        fs.rmSync(socketPath, { force: true });
        return;
      }
      throw error;
    }

    try {
      const startedAt = Date.now();
      const probe = spawn(nativeAgentPath, [
        "--probe",
        "--socket",
        socketPath,
        "--agent-main",
        path.join(projectRoot, "out", "src", "agent", "agent-main.js"),
      ], { stdio: "ignore" });
      assert.notEqual(await waitForProcessExit(probe, 2_000), 0);
      assert.ok(Date.now() - startedAt < 1_000, "native probe must retain the original 350ms total budget");
    } finally {
      for (const socket of acceptedSockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(socketPath, { force: true });
    }
  });

  test("native agent validates the first daemon frame and millisecond freshness", async (context) => {
    const testDirectory = path.join(projectRoot, ".tmp", `native-agent-probe-frame-${process.pid}-${Date.now()}`);
    const socketPath = path.join(testDirectory, "agent.sock");
    const agentMainPath = path.join(testDirectory, "agent-main.js");
    fs.mkdirSync(testDirectory, { recursive: true });
    fs.writeFileSync(agentMainPath, "// probe fixture\n", "utf8");
    const startedAt = "2026-01-02T03:04:05.500Z";
    fs.utimesSync(agentMainPath, new Date("2026-01-02T03:04:05.000Z"), new Date("2026-01-02T03:04:05.000Z"));
    const healthyFrame = `${JSON.stringify({
      type: "response",
      id: "native-probe",
      method: "daemonStatus",
      ok: true,
      payload: { agentMainPath, startedAt },
    })}\n`;
    let response = healthyFrame;
    const server = net.createServer((socket) => {
      socket.once("data", () => socket.end(response));
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    } catch (error) {
      fs.rmSync(testDirectory, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        context.skip("Unix sockets are not available in this sandbox");
        return;
      }
      throw error;
    }

    try {
      const healthyProbe = spawn(nativeAgentPath, [
        "--probe",
        "--socket",
        socketPath,
        "--agent-main",
        agentMainPath,
      ], { stdio: "ignore" });
      assert.equal(await waitForProcessExit(healthyProbe, 2_000), 0);

      response = `{"type":"response","ok":false}\n${healthyFrame}`;
      const trailingFrameProbe = spawn(nativeAgentPath, [
        "--probe",
        "--socket",
        socketPath,
        "--agent-main",
        agentMainPath,
      ], { stdio: "ignore" });
      assert.notEqual(await waitForProcessExit(trailingFrameProbe, 2_000), 0);

      response = healthyFrame;
      const newerMtime = new Date(Date.parse(startedAt) + 1_001);
      fs.utimesSync(agentMainPath, newerMtime, newerMtime);
      const staleProbe = spawn(nativeAgentPath, [
        "--probe",
        "--socket",
        socketPath,
        "--agent-main",
        agentMainPath,
      ], { stdio: "ignore" });
      assert.notEqual(await waitForProcessExit(staleProbe, 2_000), 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(testDirectory, { recursive: true, force: true });
    }
  });

  test("native agent refuses to replace a live socket owner", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const firstDaemon = await requestOnce<{ readonly pid: number }>(fixture.socketPath, {
      id: `daemon-status-before-duplicate-${process.pid}`,
      method: "daemonStatus",
    });
    const stderrChunks: Buffer[] = [];
    const duplicate = spawn(nativeAgentPath, [
      "--socket",
      fixture.socketPath,
      "--route-table",
      fixture.routeTablePath,
      "--agent-main",
      path.join(projectRoot, "out", "src", "agent", "agent-main.js"),
    ], {
      env: {
        ...process.env,
        PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS: "",
        PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    duplicate.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    context.after(async () => {
      await stopAgent(duplicate);
    });

    const duplicateExitCode = await waitForProcessExit(duplicate, 2_000);
    assert.notEqual(duplicateExitCode, null);
    assert.notEqual(duplicateExitCode, 0);

    const currentDaemon = await requestOnce<{ readonly pid: number }>(fixture.socketPath, {
      id: `daemon-status-after-duplicate-${process.pid}`,
      method: "daemonStatus",
    });

    assert.equal(currentDaemon.pid, firstDaemon.pid);
    assert.equal(Buffer.concat(stderrChunks).toString("utf8").includes("already listening"), true);
  });

  test("native agent serves concurrent hook-like clients while extension client receives events", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }
    const { socketPath } = fixture;
    const extensionClient = await openExtensionClient(socketPath);
    context.after(() => extensionClient.destroy());

    const allocationCount = 10_000;
    const networkId = "network-native-stress";
    const allocationResults = await Promise.allSettled(
      Array.from({ length: allocationCount }, (_, index) =>
        requestOnce<{
          readonly allocationId: string;
          readonly requestedPort: number;
          readonly actualPort: number;
        }>(socketPath, {
          id: `hook-${process.pid}-${index}`,
          method: "allocateRoute",
          payload: {
            name: "stress-listener",
            command: "stress-listener",
            cwd: projectRoot,
            requestedPort: 8100 + index,
            host: "127.0.0.1",
            networkId,
            routeDirection: "listen",
            compactResponse: 1,
            scanRange: 20_000,
            scanDirection: "up",
            routingMode: "hashed",
            virtualPortRangeStart: 45000,
            virtualPortRangeEnd: 65000,
          },
        }, 240_000, 30_000),
      ),
    );
    const rejectedAllocations = allocationResults.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    const allocations = allocationResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

    assert.equal(rejectedAllocations.length, 0, rejectedAllocations.slice(0, 20).map((result) => String(result.reason)).join("\n"));
    assert.equal(allocations.length, allocationCount);
    assert.equal(new Set(allocations.map((allocation) => allocation.allocationId)).size, allocationCount);
    assert.equal(new Set(allocations.map((allocation) => allocation.actualPort)).size, allocationCount);
    assert.equal(allocations.every((allocation) => allocation.actualPort >= 45000 && allocation.actualPort <= 65000), true);
    await waitForRouteTableCount(getNetworkRouteTablePath(networkId, fixture.routeTablePath), allocationCount, 120_000);
  });

  test("native agent removes endpoint route files after pending allocation release", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8204;
    const networkId = "network-native-release";
    const networkRouteTablePath = getNetworkRouteTablePath(networkId, fixture.routeTablePath);
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);
    const allocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-release`,
      method: "allocateRoute",
      payload: {
        name: "release-listener",
        command: "release-listener",
        cwd: projectRoot,
        requestedPort: logicalPort,
        host: "127.0.0.1",
        networkId,
        routeDirection: "listen",
        scanRange: 16,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    await waitForFile(routeEntryPath);
    await waitForFile(networkRouteTablePath);
    assert.equal(readRouteTable(networkRouteTablePath).routes.length, 1);
    assert.deepEqual(readRouteTable(routeEntryPath).routes, readRouteTable(networkRouteTablePath).routes);

    const released = await requestOnce<boolean>(fixture.socketPath, {
      id: `hook-${process.pid}-release-done`,
      method: "releaseRouteAllocation",
      payload: { allocationId: allocation.allocationId },
    });

    assert.equal(released, true);
    await waitForFileMissing(routeEntryPath);
  });

  test("native agent publishes compose claim files for logical and actual ports", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const networkId = "network-native-compose-claim";
    const logicalPort = 15432;
    const actualPort = 55432;
    const logicalClaimPath = getRouteTablePathForComposeClaimPort(logicalPort, fixture.routeTablePath);
    const actualClaimPath = getRouteTablePathForComposeClaimPort(actualPort, fixture.routeTablePath);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-compose-claim`,
      method: "registerExistingProcess",
      payload: {
        pid: 0,
        name: "postgres",
        command: "docker compose up postgres",
        cwd: projectRoot,
        requestedPort: logicalPort,
        actualPort,
        host: "127.0.0.1",
        networkId,
        source: "compose",
      },
    });

    await waitForFile(logicalClaimPath);
    await waitForFile(actualClaimPath);
    assert.equal(readRouteTable(logicalClaimPath).routes.length, 1);
    assert.deepEqual(readRouteTable(actualClaimPath).routes, readRouteTable(logicalClaimPath).routes);
  });

  test("native agent keeps unscoped host listeners out of cwd-matched networks", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const networkId = "network-native-cwd-infer";
    const projectCwd = path.join(projectRoot, ".tmp", "native-agent-tests", "cwd-infer-project");
    const composeCwd = path.join(projectCwd, "docker");
    const clientCwd = path.join(projectCwd, "zuzu", "client");
    const scopedRouteEntryPath = getRouteTablePathForLogicalPort(3004, networkId, fixture.routeTablePath);
    const unscopedRouteEntryPath = getRouteTablePathForLogicalPort(3004, undefined, fixture.routeTablePath);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-cwd-infer-compose`,
      method: "registerExistingProcess",
      payload: {
        pid: 0,
        name: "postgres",
        command: "docker compose up postgres",
        cwd: composeCwd,
        requestedPort: 15432,
        actualPort: 55432,
        host: "127.0.0.1",
        networkId,
        source: "compose",
      },
    });

    /*
     * This cwd deliberately matches the scoped compose project's root. Native
     * hook requests without an explicit network id are host listeners and must
     * not be adopted by a network only because the paths overlap.
     */
    const allocation = await requestOnce<{
      readonly allocationId: string;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-cwd-infer-allocate`,
      method: "allocateRoute",
      payload: {
        name: "vite",
        command: "vite --host",
        cwd: clientCwd,
        requestedPort: 3004,
        host: "127.0.0.1",
        routeDirection: "listen",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-cwd-infer-register`,
      method: "registerExistingProcess",
      payload: {
        pid: process.pid,
        name: "vite",
        command: "vite --host",
        cwd: clientCwd,
        requestedPort: 3004,
        actualPort: allocation.actualPort,
        host: "127.0.0.1",
        allocationId: allocation.allocationId,
        source: "hooked",
      },
    });

    const route = (await waitForRouteTable(
      unscopedRouteEntryPath,
      (table) => (table.routes[0] as { readonly source?: string } | undefined)?.source === "hooked",
    )).routes[0] as {
      readonly networkId?: string;
      readonly source?: string;
    };

    assert.equal(route.networkId, undefined);
    assert.equal(route.source, "hooked");
    assert.equal(fs.existsSync(scopedRouteEntryPath), false);
  });

  test("native agent reuses sender-first reservations for later listeners", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8404;
    const networkId = "network-native-send-first";
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);
    const senderAllocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-sender`,
      method: "allocateRoute",
      payload: {
        name: "wait-on",
        command: "wait-on http-get://localhost:8404/healthz",
        cwd: projectRoot,
        requestedPort: logicalPort,
        host: "::1",
        networkId,
        routeDirection: "send",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    await waitForFile(routeEntryPath);
    const pendingRoute = readRouteTable(routeEntryPath).routes[0] as {
      readonly actualPort?: number;
      readonly routeDirection?: string;
    };
    assert.equal(pendingRoute.actualPort, senderAllocation.actualPort);
    assert.equal(pendingRoute.routeDirection, "send");

    const receiverAllocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-listener`,
      method: "allocateRoute",
      payload: {
        name: "python3",
        command: "python manage.py runserver 8404",
        cwd: projectRoot,
        requestedPort: logicalPort,
        host: "127.0.0.1",
        networkId,
        routeDirection: "listen",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    assert.equal(receiverAllocation.allocationId, senderAllocation.allocationId);
    assert.equal(receiverAllocation.actualPort, senderAllocation.actualPort);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-register`,
      method: "registerExistingProcess",
      payload: {
        pid: process.pid,
        name: "python3",
        command: "python manage.py runserver 8404",
        cwd: projectRoot,
        requestedPort: logicalPort,
        actualPort: senderAllocation.actualPort,
        host: "127.0.0.1",
        networkId,
        allocationId: "",
        source: "hooked",
      },
    });

    const promotedRoute = (await waitForRouteTable(
      routeEntryPath,
      (table) => {
        const route = table.routes[0] as {
          readonly host?: string;
          readonly routeDirection?: string;
          readonly source?: string;
        } | undefined;
        return route?.host === "127.0.0.1" && route.routeDirection === "listen" && route.source === "hooked";
      },
    )).routes[0] as {
      readonly actualPort?: number;
      readonly host?: string;
      readonly routeDirection?: string;
      readonly source?: string;
    };
    assert.equal(promotedRoute.actualPort, senderAllocation.actualPort);
    assert.equal(promotedRoute.host, "127.0.0.1");
    assert.equal(promotedRoute.routeDirection, "listen");
    assert.equal(promotedRoute.source, "hooked");

    const released = await requestOnce<boolean>(fixture.socketPath, {
      id: `hook-${process.pid}-send-first-release`,
      method: "releaseRouteAllocation",
      payload: { allocationId: senderAllocation.allocationId },
    });
    assert.equal(released, false);
  });

  test("native agent sends to an existing same-port listener instead of shadow routing", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const server = await openTcpServer();
    context.after(async () => {
      await closeTcpServer(server);
    });

    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Failed to read test server address.");
    }

    const routeEntryPath = getRouteTablePathForLogicalPort(address.port, undefined, fixture.routeTablePath);
    await delay(100);

    const allocation = await requestOnce<{
      readonly allocationId: string;
      readonly requestedPort: number;
      readonly actualPort: number;
      readonly routed: boolean;
    }>(fixture.socketPath, {
      id: `hook-${process.pid}-same-port-listener`,
      method: "allocateRoute",
      payload: {
        name: "wait-on",
        command: `wait-on http-get://localhost:${address.port}/healthz`,
        cwd: projectRoot,
        requestedPort: address.port,
        host: "127.0.0.1",
        routeDirection: "send",
        scanRange: 20,
        scanDirection: "up",
        routingMode: "hashed",
        virtualPortRangeStart: 58000,
        virtualPortRangeEnd: 59000,
      },
    });

    assert.equal(allocation.allocationId, "");
    assert.equal(allocation.actualPort, address.port);
    assert.equal(allocation.routed, false);
    assert.equal(fs.existsSync(routeEntryPath), false);
  });

  test("native agent removes hooked route files after the listener disappears", async (context) => {
    const fixture = await startNativeAgent(context);
    if (fixture === undefined) {
      return;
    }

    const logicalPort = 8304;
    const actualPort = await reserveUnusedTcpPort();
    const networkId = "network-native-stale-listener";
    const routeEntryPath = getRouteTablePathForLogicalPort(logicalPort, networkId, fixture.routeTablePath);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-stale-register`,
      method: "registerExistingProcess",
      payload: {
        pid: 987654,
        name: "python3",
        command: "python manage.py runserver 8304",
        cwd: projectRoot,
        requestedPort: logicalPort,
        actualPort,
        host: "127.0.0.1",
        networkId,
        source: "hooked",
      },
    });

    await waitForFile(routeEntryPath);
    assert.equal(readRouteTable(routeEntryPath).routes.length, 1);

    await requestOnce(fixture.socketPath, {
      id: `hook-${process.pid}-stale-first-refresh`,
      method: "refreshSnapshot",
    });
    assert.equal(readRouteTable(routeEntryPath).routes.length, 1);

    await delay(2_200);
    const snapshot = await requestOnce<{ readonly routes: readonly unknown[] }>(fixture.socketPath, {
      id: `hook-${process.pid}-stale-second-refresh`,
      method: "refreshSnapshot",
    });

    assert.deepEqual(snapshot.routes, []);
    await waitForFileMissing(routeEntryPath);
  });
}

interface NativeAgentFixture {
  readonly socketPath: string;
  readonly routeTablePath: string;
}

interface RouteTable {
  readonly routes: readonly unknown[];
}

interface AgentRequest {
  readonly id: string;
  readonly method: string;
  readonly payload?: unknown;
}

interface AgentResponse<T> {
  readonly type: "response";
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: T;
  readonly error?: string;
}

interface AgentWireMessage {
  readonly type?: string;
  readonly id?: string;
  readonly ok?: boolean;
  readonly payload?: unknown;
}

function isMessageWithType(message: unknown, type: string): message is AgentWireMessage {
  return typeof message === "object" && message !== null && (message as AgentWireMessage).type === type;
}

/** Collects newline-delimited agent frames while keeping the socket reusable. */
function collectSocketMessages(socket: net.Socket): unknown[] {
  const messages: unknown[] = [];
  let buffer = "";

  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }

      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        messages.push(JSON.parse(line) as unknown);
      }
    }
  });

  return messages;
}

async function waitForSocketMessage(
  messages: readonly unknown[],
  predicate: (message: unknown) => boolean,
  timeoutMs: number,
): Promise<unknown> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const message = messages.find(predicate);
    if (message !== undefined) {
      return message;
    }
    await delay(5);
  }

  throw new Error(`Timed out waiting for native agent socket message after ${timeoutMs}ms.`);
}

async function startNativeAgent(
  context: TestContext,
  extraEnvironment: Readonly<NodeJS.ProcessEnv> = {},
): Promise<NativeAgentFixture | undefined> {
  const baseDirectory = path.join(projectRoot, ".tmp", "native-agent-tests");
  const testDirectory = path.join(
    baseDirectory,
    `run-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`,
  );
  fs.mkdirSync(testDirectory, { recursive: true });
  const socketPath = path.join(testDirectory, "agent.sock");
  const routeTablePath = path.join(testDirectory, "routes.json");
  const stderrChunks: Buffer[] = [];
  const agent = spawn(nativeAgentPath, [
    "--socket",
    socketPath,
    "--route-table",
    routeTablePath,
    "--agent-main",
    path.join(projectRoot, "out", "src", "agent", "agent-main.js"),
  ], {
    env: buildNodeRuntimeEnvironment({
      ...process.env,
      PORT_MANAGER_ROUTE_TABLE_TTL_SECONDS: "",
      PORT_MANAGER_AGENT_DISABLE_HOOK_RECOVERY: "1",
      ...extraEnvironment,
    }),
    stdio: ["ignore", "ignore", "pipe"],
  });
  agent.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  context.after(async () => {
    await stopAgent(agent);
    await fs.promises.rm(socketPath, { force: true }).catch(() => undefined);
    await fs.promises.rm(routeTablePath, { force: true }).catch(() => undefined);
    await removeRouteTableSiblings(routeTablePath);
    await fs.promises.rm(testDirectory, { recursive: true, force: true }).catch(() => undefined);
  });

  try {
    await waitForAgent(socketPath);
  } catch (error) {
    if (stderrChunks.some((chunk) => chunk.toString("utf8").includes("Operation not permitted"))) {
      context.skip("native agent cannot bind Unix sockets in this sandbox");
      return undefined;
    }

    throw error;
  }

  return { socketPath, routeTablePath };
}

async function waitForAgent(socketPath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const socket = await connectSocket(socketPath);
      socket.destroy();
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for native agent.");
}

async function openExtensionClient(socketPath: string): Promise<net.Socket> {
  const socket = await connectSocket(socketPath);
  const requestId = `extension-${process.pid}-events`;
  let buffer = "";

  socket.setEncoding("utf8");
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("Timed out waiting for extension snapshot response."));
    }, 10_000);

    socket.on("data", (chunk) => {
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Partial<AgentResponse<unknown>>;

        if (message.type !== "response" || message.id !== requestId) {
          continue;
        }

        clearTimeout(timer);
        if (!message.ok) {
          reject(new Error(message.error ?? "Native agent snapshot request failed."));
          return;
        }

        resolve();
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  socket.write(`${JSON.stringify({ id: requestId, method: "refreshSnapshot" })}\n`);
  await ready;
  return socket;
}

async function requestOnce<T = unknown>(
  socketPath: string,
  request: AgentRequest,
  timeoutMs = 10_000,
  connectTimeoutMs = 1000,
): Promise<T> {
  const socket = await connectSocket(socketPath, connectTimeoutMs);

  return new Promise<T>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      socket.destroy();
      reject(new Error(`Timed out waiting for native agent response: ${request.method}`));
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;

      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) {
          return;
        }

        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const message = JSON.parse(line) as Partial<AgentResponse<T>>;

        if (message.type !== "response" || message.id !== request.id) {
          continue;
        }

        clearTimeout(timer);
        settled = true;
        socket.destroy();
        if (!message.ok) {
          reject(new Error(message.error ?? "Native agent request failed."));
          return;
        }

        resolve(message.payload as T);
      }
    });
    socket.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Native agent connection closed before response: ${request.method}`));
    });
    socket.write(`${JSON.stringify(request)}\n`);
  });
}

async function connectSocket(socketPath: string, timeoutMs = 1000): Promise<net.Socket> {
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await connectSocketOnce(socketPath, Math.max(100, timeoutMs - (Date.now() - startedAt)));
    } catch (error) {
      lastError = error;
      if (!isRetryableConnectError(error)) {
        throw error;
      }
      await delay(10);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out connecting to native agent: ${socketPath}`);
}

function connectSocketOnce(socketPath: string, timeoutMs: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out connecting to native agent: ${socketPath}`));
    }, timeoutMs);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isRetryableConnectError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  const code = (error as { readonly code?: unknown }).code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EAGAIN" || code === "ECONNRESET";
}

async function waitForFile(filePath: string): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fs.promises.access(filePath);
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Timed out waiting for file: ${filePath}`);
}

async function waitForFileMissing(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!fs.existsSync(filePath)) {
      return;
    }

    await delay(100);
  }

  throw new Error(`Timed out waiting for file removal: ${filePath}`);
}

async function waitForRouteTableCount(filePath: string, expectedCount: number, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastCount = -1;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastCount = readRouteTable(filePath).routes.length;
      if (lastCount === expectedCount) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(250);
  }

  throw new Error(
    `Timed out waiting for route table count ${expectedCount} at ${filePath}; last count=${lastCount}; last error=${String(lastError)}`,
  );
}

async function waitForRouteTable(
  filePath: string,
  predicate: (table: RouteTable) => boolean,
  timeoutMs = 5_000,
): Promise<RouteTable> {
  const startedAt = Date.now();
  let lastTable: RouteTable | undefined;
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastTable = readRouteTable(filePath);
      if (predicate(lastTable)) {
        return lastTable;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(100);
  }

  throw new Error(
    `Timed out waiting for route table content at ${filePath}; last routes=${JSON.stringify(lastTable?.routes ?? [])}; last error=${String(lastError)}`,
  );
}

function readRouteTable(filePath: string): RouteTable {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as RouteTable;
}

async function reserveUnusedTcpPort(): Promise<number> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Failed to reserve an unused TCP port.");
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });

  return address.port;
}

async function openTcpServer(): Promise<net.Server> {
  const server = net.createServer((socket) => socket.end("ok"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  return server;
}

async function closeTcpServer(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

async function stopAgent(agent: ChildProcess): Promise<void> {
  if (agent.exitCode !== null || agent.killed) {
    return;
  }

  agent.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 1000);
    agent.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  if (agent.exitCode === null && !agent.killed) {
    agent.kill("SIGKILL");
  }
}

async function waitForProcessExit(process: ChildProcess, timeoutMs: number): Promise<number | null> {
  if (process.exitCode !== null) {
    return process.exitCode;
  }

  return await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    process.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function removeRouteTableSiblings(routeTablePath: string): Promise<void> {
  const directory = path.dirname(routeTablePath);
  const stem = path.basename(routeTablePath, path.extname(routeTablePath));
  const entries = await fs.promises.readdir(directory).catch(() => []);

  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(`${stem}-`))
      .map((entry) => fs.promises.rm(path.join(directory, entry), { force: true }).catch(() => undefined)),
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
