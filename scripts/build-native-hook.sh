#!/bin/sh
set -eu

# Builds the optional native socket hook used by external OS terminals.
# The VSIX includes the resulting library when a supported compiler exists.

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOOK_SOURCE_FILE="$ROOT_DIR/native/hook/portmanager_hook.c"
ASDF_SHIM_SOURCE_FILE="$ROOT_DIR/native/asdf-shim/portmanager_asdf_shim.c"
TTY_INPUT_SOURCE_FILE="$ROOT_DIR/native/tty-input/portmanager_tty_input.c"
TCP_ROUTER_SOURCE_FILE="$ROOT_DIR/native/router/portmanager_tcp_router.c"
HOST_EXPOSURE_PROXY_SOURCE_FILE="$ROOT_DIR/native/host-exposure/portmanager_host_exposure_proxy.c"
PROCESS_LOOKUP_SOURCE_FILE="$ROOT_DIR/native/process-lookup/portmanager_process_lookup.c"
CONTAINER_MAP_SOURCE_FILE="$ROOT_DIR/native/container-mutation/portmanager_container_map.c"
DOCKER_SHIM_SOURCE_FILE="$ROOT_DIR/native/docker-shim/portmanager_docker_shim.c"
AGENT_SOURCE_FILES="$ROOT_DIR/native/agent/portmanager_agent.c $ROOT_DIR/native/agent/portmanager_agent_state.c $ROOT_DIR/native/agent/portmanager_agent_json.c"
OUTPUT_DIR="$ROOT_DIR/media/native"

mkdir -p "$OUTPUT_DIR"

if ! command -v cc >/dev/null 2>&1; then
  echo "cc not found; skipping Port Manager native hook build"
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    cc -Wall -Wextra -O2 -dynamiclib "$HOOK_SOURCE_FILE" -o "$OUTPUT_DIR/libportmanager_hook.dylib"
    cc -Wall -Wextra -O2 "$ASDF_SHIM_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_asdf_shim"
    cc -Wall -Wextra -O2 "$TTY_INPUT_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tty_input"
    cc -Wall -Wextra -O2 "$TCP_ROUTER_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tcp_router"
    cc -Wall -Wextra -O2 -pthread "$HOST_EXPOSURE_PROXY_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_host_exposure_proxy"
    cc -Wall -Wextra -O2 "$PROCESS_LOOKUP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_lookup"
    cc -Wall -Wextra -O2 "$CONTAINER_MAP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_container_map"
    cc -Wall -Wextra -O2 "$DOCKER_SHIM_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_docker_shim"
    cc -Wall -Wextra -O2 $AGENT_SOURCE_FILES -o "$OUTPUT_DIR/portmanager_agent"
    if command -v codesign >/dev/null 2>&1; then
      # DYLD-injected helpers must survive macOS library validation paths.
      # Linker-signed output can be rejected by some runtimes, so sign the
      # final artifacts explicitly after every rebuild.
      codesign --force --sign - "$OUTPUT_DIR/libportmanager_hook.dylib" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_asdf_shim" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_tty_input" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_tcp_router" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_host_exposure_proxy" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_process_lookup" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_container_map" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_docker_shim" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_agent" >/dev/null
    fi
    ;;
  Linux)
    cc -Wall -Wextra -O2 -fPIC -shared "$HOOK_SOURCE_FILE" -ldl -o "$OUTPUT_DIR/libportmanager_hook.so"
    cc -Wall -Wextra -O2 "$TTY_INPUT_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tty_input"
    cc -Wall -Wextra -O2 "$TCP_ROUTER_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tcp_router"
    cc -Wall -Wextra -O2 -pthread "$HOST_EXPOSURE_PROXY_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_host_exposure_proxy"
    cc -Wall -Wextra -O2 "$PROCESS_LOOKUP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_process_lookup"
    cc -Wall -Wextra -O2 "$CONTAINER_MAP_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_container_map"
    cc -Wall -Wextra -O2 "$DOCKER_SHIM_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_docker_shim"
    cc -Wall -Wextra -O2 $AGENT_SOURCE_FILES -o "$OUTPUT_DIR/portmanager_agent"
    ;;
  *)
    echo "Unsupported native hook platform; skipping"
    ;;
esac
