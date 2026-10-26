/**
 * Preload repair for the children of a hardened `uv run`.
 *
 * The package-manager shim launches native package managers such as uv with
 * DYLD_INSERT_LIBRARIES so the processes they spawn (python, celery, uvicorn,
 * ...) inherit the hook. A uv signed with the hardened runtime and without the
 * `com.apple.security.cs.allow-dyld-environment-variables` entitlement — the
 * official Astral installer build — defeats that: dyld ignores DYLD_* for it and
 * also removes them from its environment. Every server started by `uv run` then
 * binds the real 127.0.0.1 while hooked clients look for it on the network
 * loopback, and nothing reports the escape.
 *
 * uv itself cannot be hooked, so the repair moves to the next boundary: the
 * command uv runs. For `uv run <command>` the shim puts
 * `/bin/sh -c '<preamble>exec "$@"'` in front of the command. The preamble is the
 * native hook's own `sh -c` boundary repair (PM_SH_C_PREAMBLE): it restores
 * DYLD_INSERT_LIBRARIES from the surviving PORT_MANAGER_DYLD_INSERT_LIBRARIES
 * hint and puts the runtime-shim directory first on PATH, so the command resolves
 * through the extension's launchers like any `sh -c` child of a hooked parent.
 *
 * The rewrite is limited to invocations where it cannot change what uv runs:
 * - the resolved uv drops the preload (hardened runtime, no DYLD entitlement);
 * - every option before the command is a known uv option, so the command
 *   position is certain;
 * - the command is a plain name (including `python`), `-m <module>`, or a `.py`
 *   file without PEP 723 inline metadata (those run in uv's isolated script
 *   environment, which `python <file>` would bypass).
 * Anything else keeps today's exec. A `uv run` left unrepaired under a
 * preload-dropping uv prints one notice instead of escaping silently. `uvx` and
 * `uv tool run` take a tool spec as the positional, so they have no insertion
 * point and are not rewritten.
 */

/**
 * Exact copy of PM_SH_C_PREAMBLE in native/hook/portmanager_hook.c. A unit test
 * compares both, so a change to the native boundary repair reaches this one too.
 * The leading `: pmdyld;` sentinel keeps a hooked parent from wrapping it again.
 */
export const NATIVE_SH_C_PRELOAD_PREAMBLE =
  ': pmdyld;if [ -n "$PORT_MANAGER_DYLD_INSERT_LIBRARIES" ] && [ "${PORT_MANAGER_HOOK_DISABLED:-0}" != 1 ] && [ "${PORT_MANAGER_HOOK:-1}" != 0 ]; then DYLD_INSERT_LIBRARIES="$PORT_MANAGER_DYLD_INSERT_LIBRARIES"; export DYLD_INSERT_LIBRARIES; if [ -n "$PORT_MANAGER_RUNTIME_SHIM_DIR" ] && [ -d "$PORT_MANAGER_RUNTIME_SHIM_DIR" ]; then case ":$PATH:" in ":$PORT_MANAGER_RUNTIME_SHIM_DIR:"*) ;; *) PATH="$PORT_MANAGER_RUNTIME_SHIM_DIR:$PATH"; export PATH ;; esac; fi; fi;';

/** `sh -c` script uv runs in place of the command: repair the preload, then become the command. */
export const UV_RUN_PRELOAD_TRAMPOLINE = `${NATIVE_SH_C_PRELOAD_PREAMBLE}exec "$@"`;

/*
 * Options listed by `uv run --help` (uv 0.13), global options included because
 * clap accepts them on either side of `run`. An option missing from both lists
 * disables the rewrite for that invocation, so a newer uv only loses the repair
 * instead of having a value mistaken for the command. `-m/--module`,
 * `-s/--script`, `--gui-script` and `-h/--help` are deliberately absent: they
 * change what the positional means and are handled (or refused) separately.
 */
const UV_VALUE_OPTIONS: readonly string[] = [
  "--allow-insecure-host", "--cache-dir", "--color", "--config-file", "--config-setting",
  "--config-settings-package", "--default-index", "--directory", "--env-file", "--exclude-newer",
  "--exclude-newer-package", "--extra", "--extra-index-url", "--find-links", "--fork-strategy",
  "--group", "--index", "--index-strategy", "--index-url", "--keyring-provider", "--link-mode",
  "--no-binary-package", "--no-build-isolation-package", "--no-build-package", "--no-editable-package",
  "--no-extra", "--no-group", "--no-sources-package", "--only-group", "--package", "--prerelease",
  "--prerelease-package", "--project", "--python", "--python-platform", "--refresh-package",
  "--reinstall-package", "--resolution", "--upgrade-group", "--upgrade-package", "--with",
  "--with-editable", "--with-requirements",
  "-C", "-P", "-f", "-i", "-p", "-w",
];
const UV_FLAG_OPTIONS: readonly string[] = [
  "--active", "--all-extras", "--all-groups", "--all-packages", "--compile-bytecode", "--exact",
  "--frozen", "--isolated", "--locked", "--managed-python", "--no-binary", "--no-build",
  "--no-build-isolation", "--no-cache", "--no-config", "--no-default-groups", "--no-dev",
  "--no-editable", "--no-env-file", "--no-index", "--no-managed-python", "--no-progress",
  "--no-project", "--no-python-downloads", "--no-require-build-hashes", "--no-sources", "--no-sync",
  "--offline", "--only-dev", "--quiet", "--refresh", "--reinstall", "--require-build-hashes",
  "--system-certs", "--upgrade", "--verbose",
  "-U", "-n", "-q", "-qq", "-qqq", "-v", "-vv", "-vvv",
];
// Short value options also accept an attached value (`-p3.12`, `-p=3.12`).
const UV_ATTACHED_SHORT_VALUE_PATTERN = `-[${UV_VALUE_OPTIONS.filter(option => /^-[A-Za-z]$/.test(option)).map(option => option[1]).join("")}]?*`;

/**
 * Shell functions for the package-manager shim. They only read arguments,
 * environment and (for detection) the target's code signature; the caller
 * decides when to call them.
 *
 * - `__pm_uv_preload_repair_enabled`: the hook is on and its hint names a
 *   readable library. Like the native runtime launcher, a missing hook library
 *   (an upgraded extension under an old terminal) disables the repair instead of
 *   handing dyld a path that would abort the child before main().
 * - `__pm_uv_run_rewrite_plan`: parses with builtins only and sets
 *   `__pm_uv_seen_run`, `__pm_uv_command_index`, `__pm_uv_command_kind`
 *   (command|module|script) and `__pm_uv_module_index`.
 * - `__pm_target_drops_preload`: reads the CodeDirectory flags and entitlements.
 *   Only the `flags=0x…(…)` list is matched, because codesign also prints
 *   `Runtime Version=…`. Any codesign failure answers "no", keeping today's path.
 */
export function buildUvRunPreloadRepairFunctions(): string {
  return `__pm_uv_preload_exec=${shellQuote(UV_RUN_PRELOAD_TRAMPOLINE)}

__pm_uv_preload_repair_enabled() {
  [ -n "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES:-}" ] || return 1
  [ -r "\${PORT_MANAGER_DYLD_INSERT_LIBRARIES}" ] || return 1
  [ "\${PORT_MANAGER_HOOK_DISABLED:-0}" != 1 ] || return 1
  [ "\${PORT_MANAGER_HOOK:-1}" != 0 ]
}

__pm_uv_option_takes_value() {
  case "$1" in
    ${UV_VALUE_OPTIONS.join("|")}) return 0 ;;
  esac
  return 1
}

__pm_uv_option_is_flag() {
  case "$1" in
    ${UV_FLAG_OPTIONS.join("|")}) return 0 ;;
  esac
  return 1
}

__pm_uv_run_rewrite_plan() {
  __pm_uv_seen_run=0
  __pm_uv_command_index=0
  __pm_uv_command_kind=""
  __pm_uv_module_index=0
  __pm_uv_changes_directory=0
  __pm_uv_index=0
  __pm_uv_expect_value=0
  __pm_uv_options_ended=0
  for __pm_uv_arg do
    __pm_uv_index=$((__pm_uv_index + 1))
    if [ "$__pm_uv_expect_value" = 1 ]; then
      __pm_uv_expect_value=0
      continue
    fi
    if [ "$__pm_uv_options_ended" = 0 ]; then
      case "$__pm_uv_arg" in
        --)
          [ "$__pm_uv_seen_run" = 1 ] || return 1
          __pm_uv_options_ended=1
          continue
          ;;
        -m|--module)
          [ "$__pm_uv_seen_run" = 1 ] || return 1
          __pm_uv_module_index=$__pm_uv_index
          continue
          ;;
        --directory|--directory=*)
          # uv runs the command from that directory; a relative script path is not ours to read.
          __pm_uv_changes_directory=1
          ;;
      esac
      case "$__pm_uv_arg" in
        --*=*)
          __pm_uv_option_takes_value "\${__pm_uv_arg%%=*}" || return 1
          continue
          ;;
        ${UV_ATTACHED_SHORT_VALUE_PATTERN})
          continue
          ;;
        -?*)
          if __pm_uv_option_takes_value "$__pm_uv_arg"; then
            __pm_uv_expect_value=1
          elif ! __pm_uv_option_is_flag "$__pm_uv_arg"; then
            return 1
          fi
          continue
          ;;
      esac
    fi
    if [ "$__pm_uv_seen_run" = 0 ]; then
      [ "$__pm_uv_arg" = run ] || return 1
      __pm_uv_seen_run=1
      continue
    fi

    # The first positional after \`run\` is what uv executes.
    __pm_uv_command_index=$__pm_uv_index
    case "$__pm_uv_arg" in
      ""|-*|*://*) return 1 ;;
    esac
    # A directory runs as a Python package (__main__.py), not as a command.
    [ ! -d "$__pm_uv_arg" ] || return 1
    if [ "$__pm_uv_module_index" != 0 ]; then
      case "$__pm_uv_arg" in
        */*) return 1 ;;
      esac
      __pm_uv_command_kind=module
      return 0
    fi
    case "$__pm_uv_arg" in
      *.py)
        [ "$__pm_uv_changes_directory" = 0 ] || return 1
        if [ -f "$__pm_uv_arg" ] && grep -q '^# /// script$' "$__pm_uv_arg" 2>/dev/null; then
          return 1
        fi
        __pm_uv_command_kind=script
        return 0
        ;;
      *.pyw|*.pyz|*.pyc|*/*) return 1 ;;
    esac
    __pm_uv_command_kind=command
    return 0
  done
  return 1
}

__pm_target_drops_preload() {
  [ -x /usr/bin/codesign ] || return 1
  __pm_signature="$(/usr/bin/codesign -d --entitlements - --verbose=1 "$1" 2>&1)" || return 1
  case "$__pm_signature" in
    *com.apple.security.cs.allow-dyld-environment-variables*) return 1 ;;
    *"flags=0x"*) ;;
    *) return 1 ;;
  esac
  __pm_signature_flags="\${__pm_signature#*flags=0x}"
  __pm_signature_flags="\${__pm_signature_flags%%)*}"
  __pm_signature_flags="\${__pm_signature_flags#*(}"
  case ",$__pm_signature_flags," in
    *,runtime,*) return 0 ;;
  esac
  return 1
}`;
}

/**
 * Inline shim step placed right before the native package manager is exec'd.
 * It runs at top level because only top-level code can replace the shim's own
 * "$@": the arguments are rebuilt by appending to "$@" while iterating the
 * original list, then shifting the original count away.
 *
 * Argument parsing comes first and needs no process, so dependency commands
 * (`uv sync`, guarded `uv pip install`, ...) never pay for or print anything;
 * codesign only runs for a `uv run` invocation.
 */
export function buildUvRunPreloadRepairShell(): string {
  return `if [ "\${__pm_name}" = uv ] && __pm_uv_preload_repair_enabled; then
        if __pm_uv_run_rewrite_plan "$@"; then
          if __pm_target_drops_preload "\${__pm_target}"; then
            __pm_uv_count=$#
            __pm_uv_index=0
            for __pm_uv_arg do
              __pm_uv_index=$((__pm_uv_index + 1))
              [ "$__pm_uv_index" != "$__pm_uv_module_index" ] || continue
              if [ "$__pm_uv_index" = "$__pm_uv_command_index" ]; then
                case "$__pm_uv_command_kind" in
                  module) set -- "$@" /bin/sh -c "$__pm_uv_preload_exec" python python -m ;;
                  script) set -- "$@" /bin/sh -c "$__pm_uv_preload_exec" python python ;;
                  *) set -- "$@" /bin/sh -c "$__pm_uv_preload_exec" "$__pm_uv_arg" ;;
                esac
              fi
              set -- "$@" "$__pm_uv_arg"
            done
            shift "$__pm_uv_count"
          fi
        elif [ "$__pm_uv_seen_run" = 1 ] && __pm_target_drops_preload "\${__pm_target}"; then
          printf '%s\\n' "Port Manager: \${__pm_target} is signed with the hardened runtime and drops DYLD_INSERT_LIBRARIES; this uv run form cannot be re-routed, so its processes run outside the logical network." >&2
        fi
      fi`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
