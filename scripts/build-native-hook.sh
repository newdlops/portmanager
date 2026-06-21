#!/bin/sh
set -eu

# Builds the optional native socket hook used by external OS terminals.
# The VSIX includes the resulting library when a supported compiler exists.

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SOURCE_FILE="$ROOT_DIR/native/hook/portmanager_hook.c"
OUTPUT_DIR="$ROOT_DIR/media/native"

mkdir -p "$OUTPUT_DIR"

if ! command -v cc >/dev/null 2>&1; then
  echo "cc not found; skipping Port Manager native hook build"
  exit 0
fi

case "$(uname -s)" in
  Darwin)
    cc -Wall -Wextra -O2 -dynamiclib "$SOURCE_FILE" -o "$OUTPUT_DIR/libportmanager_hook.dylib"
    ;;
  Linux)
    cc -Wall -Wextra -O2 -fPIC -shared "$SOURCE_FILE" -ldl -o "$OUTPUT_DIR/libportmanager_hook.so"
    ;;
  *)
    echo "Unsupported native hook platform; skipping"
    ;;
esac
