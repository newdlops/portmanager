#!/bin/sh
set -eu

# Builds the native socket hook and helpers for one VS Code Marketplace target.
# Native routing is a core product capability, so release builds fail closed
# instead of silently packaging stale artifacts from a different machine.

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOOK_SOURCE_FILE="$ROOT_DIR/native/hook/portmanager_hook.c"
ASDF_SHIM_SOURCE_FILE="$ROOT_DIR/native/asdf-shim/portmanager_asdf_shim.c"
PROCESS_SCOPE_SHIM_SOURCE_FILE="$ROOT_DIR/native/process-scope-shim/portmanager_process_scope_shim.c"
TTY_INPUT_SOURCE_FILE="$ROOT_DIR/native/tty-input/portmanager_tty_input.c"
TCP_ROUTER_SOURCE_FILE="$ROOT_DIR/native/router/portmanager_tcp_router.c"
PEER_PROCESS_SOURCE_FILE="$ROOT_DIR/native/shared/pm_peer_process.c"
# Shared development log endpoint (PORT_MANAGER_DEV_LOG). See docs/dev-logging.md.
DEV_LOG_SOURCE_FILE="$ROOT_DIR/native/shared/pm_dev_log.c"
PROCESS_TRACKER_SOURCE_FILE="$ROOT_DIR/native/process-tracker/portmanager_process_tracker.c"
HOST_EXPOSURE_PROXY_SOURCE_FILE="$ROOT_DIR/native/host-exposure/portmanager_host_exposure_proxy.c"
PROCESS_LOOKUP_SOURCE_FILE="$ROOT_DIR/native/process-lookup/portmanager_process_lookup.c"
CONTAINER_MAP_SOURCE_FILE="$ROOT_DIR/native/container-mutation/portmanager_container_map.c"
DOCKER_SHIM_SOURCE_FILE="$ROOT_DIR/native/docker-shim/portmanager_docker_shim.c"
AGENT_SOURCE_FILES="$ROOT_DIR/native/agent/portmanager_agent.c $ROOT_DIR/native/agent/portmanager_agent_probe.c $ROOT_DIR/native/agent/portmanager_agent_state.c $ROOT_DIR/native/agent/portmanager_agent_json.c $ROOT_DIR/native/agent/portmanager_agent_dns.c $ROOT_DIR/native/agent/portmanager_agent_scan.c $ROOT_DIR/native/agent/portmanager_agent_output.c $ROOT_DIR/native/agent/portmanager_agent_publication.c $PEER_PROCESS_SOURCE_FILE"
OUTPUT_DIR="${PORT_MANAGER_NATIVE_OUTPUT_DIR:-$ROOT_DIR/media/native}"
PACKAGE_VERSION="unknown"
if command -v node >/dev/null 2>&1; then
  PACKAGE_VERSION="$(node -e 'process.stdout.write(require(process.argv[1]).version || "unknown")' "$ROOT_DIR/package.json" 2>/dev/null || printf 'unknown')"
fi
AGENT_VERSION_DEFINE="-DPORTMANAGER_PACKAGE_VERSION=\"$PACKAGE_VERSION\""

mkdir -p "$OUTPUT_DIR"

if ! command -v cc >/dev/null 2>&1; then
  echo "cc not found; Port Manager native artifacts cannot be built" >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node not found; Port Manager native artifacts cannot be verified" >&2
  exit 1
fi

HOST_SYSTEM="$(uname -s)"
HOST_MACHINE="$(uname -m)"
case "$HOST_SYSTEM:$HOST_MACHINE" in
  Darwin:arm64) DEFAULT_NATIVE_TARGET="darwin-arm64" ;;
  Darwin:x86_64) DEFAULT_NATIVE_TARGET="darwin-x64" ;;
  Linux:aarch64|Linux:arm64) DEFAULT_NATIVE_TARGET="linux-arm64" ;;
  Linux:x86_64|Linux:amd64) DEFAULT_NATIVE_TARGET="linux-x64" ;;
  *)
    echo "Unsupported native build host: $HOST_SYSTEM $HOST_MACHINE" >&2
    exit 1
    ;;
esac

NATIVE_TARGET="${PORT_MANAGER_NATIVE_TARGET:-$DEFAULT_NATIVE_TARGET}"
case "$NATIVE_TARGET" in
  darwin-arm64) TARGET_SYSTEM="Darwin"; TARGET_ARCH="arm64" ;;
  darwin-x64) TARGET_SYSTEM="Darwin"; TARGET_ARCH="x86_64" ;;
  linux-arm64) TARGET_SYSTEM="Linux"; TARGET_ARCH="arm64" ;;
  linux-x64) TARGET_SYSTEM="Linux"; TARGET_ARCH="x86_64" ;;
  *)
    echo "Unsupported Port Manager native target: $NATIVE_TARGET" >&2
    exit 1
    ;;
esac

if [ "$HOST_SYSTEM" != "$TARGET_SYSTEM" ]; then
  echo "Native target $NATIVE_TARGET must be built on $TARGET_SYSTEM, not $HOST_SYSTEM" >&2
  exit 1
fi

if [ "$TARGET_SYSTEM" = "Linux" ]; then
  case "$HOST_MACHINE:$TARGET_ARCH" in
    x86_64:x86_64|amd64:x86_64|aarch64:arm64|arm64:arm64) ;;
    *)
      echo "Linux native target $NATIVE_TARGET requires a matching build host architecture" >&2
      exit 1
      ;;
  esac
fi

case "$TARGET_SYSTEM" in
  Darwin)
    MACOS_DEPLOYMENT_TARGET="${PORT_MANAGER_MACOS_DEPLOYMENT_TARGET:-11.0}"
    DARWIN_TARGET_FLAGS="-arch $TARGET_ARCH -mmacosx-version-min=$MACOS_DEPLOYMENT_TARGET"
    rm -f "$OUTPUT_DIR/libportmanager_hook.so"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS -dynamiclib "$HOOK_SOURCE_FILE" "$DEV_LOG_SOURCE_FILE" -o "$OUTPUT_DIR/libportmanager_hook.dylib"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$ASDF_SHIM_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_asdf_shim"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$PROCESS_SCOPE_SHIM_SOURCE_FILE" "$PEER_PROCESS_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_scope_shim"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$TTY_INPUT_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tty_input"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS -pthread "$TCP_ROUTER_SOURCE_FILE" "$PEER_PROCESS_SOURCE_FILE" "$DEV_LOG_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tcp_router"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS -pthread "$HOST_EXPOSURE_PROXY_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_host_exposure_proxy"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$PROCESS_LOOKUP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_lookup"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$PROCESS_TRACKER_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_tracker"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$CONTAINER_MAP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_container_map"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS "$DOCKER_SHIM_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_docker_shim"
    cc -Wall -Wextra -O2 $DARWIN_TARGET_FLAGS -pthread "$AGENT_VERSION_DEFINE" $AGENT_SOURCE_FILES "$DEV_LOG_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_agent"
    if command -v codesign >/dev/null 2>&1; then
      # DYLD-injected helpers must survive macOS library validation paths.
      # Linker-signed output can be rejected by some runtimes, so sign the
      # final artifacts explicitly after every rebuild.
      codesign --force --sign - "$OUTPUT_DIR/libportmanager_hook.dylib" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_asdf_shim" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_process_scope_shim" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_tty_input" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_tcp_router" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_host_exposure_proxy" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_process_lookup" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_process_tracker" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_container_map" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_docker_shim" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_agent" >/dev/null
    fi
    ;;
  Linux)
    rm -f "$OUTPUT_DIR/libportmanager_hook.dylib" "$OUTPUT_DIR/portmanager_asdf_shim" "$OUTPUT_DIR/portmanager_process_scope_shim"
    cc -Wall -Wextra -O2 -fPIC -shared "$HOOK_SOURCE_FILE" "$DEV_LOG_SOURCE_FILE" -ldl -o "$OUTPUT_DIR/libportmanager_hook.so"
    cc -Wall -Wextra -O2 "$TTY_INPUT_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tty_input"
    cc -Wall -Wextra -O2 -pthread "$TCP_ROUTER_SOURCE_FILE" "$PEER_PROCESS_SOURCE_FILE" "$DEV_LOG_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tcp_router"
    cc -Wall -Wextra -O2 -pthread "$HOST_EXPOSURE_PROXY_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_host_exposure_proxy"
    cc -Wall -Wextra -O2 "$PROCESS_LOOKUP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_lookup"
    cc -Wall -Wextra -O2 "$PROCESS_TRACKER_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_tracker"
    cc -Wall -Wextra -O2 "$CONTAINER_MAP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_container_map"
    cc -Wall -Wextra -O2 "$DOCKER_SHIM_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_docker_shim"
    cc -Wall -Wextra -O2 -pthread "$AGENT_VERSION_DEFINE" $AGENT_SOURCE_FILES "$DEV_LOG_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_agent"
    ;;
esac

node "$ROOT_DIR/scripts/verify-native-artifacts.js" "$NATIVE_TARGET"
