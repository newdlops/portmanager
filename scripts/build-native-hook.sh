#!/bin/sh
set -eu

# Builds the optional native socket hook used by external OS terminals.
# The VSIX includes the resulting library when a supported compiler exists.

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
HOOK_SOURCE_FILE="$ROOT_DIR/native/hook/portmanager_hook.c"
ASDF_SHIM_SOURCE_FILE="$ROOT_DIR/native/asdf-shim/portmanager_asdf_shim.c"
TTY_INPUT_SOURCE_FILE="$ROOT_DIR/native/tty-input/portmanager_tty_input.c"
TCP_ROUTER_SOURCE_FILE="$ROOT_DIR/native/router/portmanager_tcp_router.c"
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
    if command -v codesign >/dev/null 2>&1; then
      # DYLD-injected helpers must survive macOS library validation paths.
      # Linker-signed output can be rejected by some runtimes, so sign the
      # final artifacts explicitly after every rebuild.
      codesign --force --sign - "$OUTPUT_DIR/libportmanager_hook.dylib" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_asdf_shim" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_tty_input" >/dev/null
      codesign --force --sign - "$OUTPUT_DIR/portmanager_tcp_router" >/dev/null
    fi
    ;;
  Linux)
    cc -Wall -Wextra -O2 -fPIC -shared "$HOOK_SOURCE_FILE" -ldl -o "$OUTPUT_DIR/libportmanager_hook.so"
    cc -Wall -Wextra -O2 "$TTY_INPUT_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tty_input"
    cc -Wall -Wextra -O2 "$TCP_ROUTER_SOURCE_FILE" -o "$OUTPUT_DIR/portmanager_tcp_router"
    ;;
  *)
    echo "Unsupported native hook platform; skipping"
    ;;
esac
