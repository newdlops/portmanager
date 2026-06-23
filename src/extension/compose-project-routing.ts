/**
 * Shell-side Docker Compose project routing for attached logical networks.
 *
 * Socket hooks route application traffic, but Compose CLI commands choose a
 * project name from cwd and compose files before any port is involved. These
 * helpers write a small dynamic map and generate shell functions that redirect
 * `docker compose`/`podman compose` to the network-scoped clone project when
 * the caller is inside the original compose working directory.
 */

export interface ComposeProjectRoutingRow {
  /** Logical network whose attached terminal owns this compose project view. */
  readonly networkId: string;
  /** Container runtime command that should receive the project override. */
  readonly runtime: "docker" | "podman";
  /** Original compose working directory used by the user's shell. */
  readonly workingDirectory: string;
  /** Network-scoped compose project name created by clone attach. */
  readonly attachedProjectName: string;
  /** Direct container id/name rewrites for Docker CLI commands like exec/logs. */
  readonly containerMappings?: readonly ComposeContainerRoutingMapping[];
}

export interface ComposeContainerRoutingMapping {
  /** Full original container id before clone attach stopped it. */
  readonly originalContainerId: string;
  /** Original container name shown by Docker/Podman. */
  readonly originalContainerName: string;
  /** Full attached clone container id. */
  readonly attachedContainerId: string;
  /** Attached clone container name shown by Docker/Podman. */
  readonly attachedContainerName: string;
}

/** Serializes rows as tab-separated text so shell wrappers can read it cheaply. */
export function serializeComposeProjectRoutingRows(rows: readonly ComposeProjectRoutingRow[]): string {
  const lines = rows.flatMap((row) => {
    const baseFields = [
      "project",
      sanitizeField(row.networkId),
      row.runtime,
      sanitizeField(trimTrailingSlashes(row.workingDirectory)),
      sanitizeField(row.attachedProjectName),
    ].join("\t");
    const containerFields = (row.containerMappings ?? []).map((mapping) =>
      [
        "container",
        sanitizeField(row.networkId),
        row.runtime,
        sanitizeField(trimTrailingSlashes(row.workingDirectory)),
        sanitizeField(stripContainerNamePrefix(mapping.originalContainerId)),
        sanitizeField(stripContainerNamePrefix(mapping.originalContainerName)),
        sanitizeField(stripContainerNamePrefix(mapping.attachedContainerId)),
        sanitizeField(stripContainerNamePrefix(mapping.attachedContainerName)),
      ].join("\t"),
    );

    return [baseFields, ...containerFields];
  });

  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** Exports the dynamic map path and installs runtime wrappers in the current shell. */
export function buildComposeProjectRoutingShell(filePath: string): string {
  return `${shellExport("PORT_MANAGER_COMPOSE_ROUTING_FILE", filePath)}
${buildComposeProjectRoutingFunctionScript()}`;
}

/** Builds an executable PATH shim for child_process.spawn("docker", ...). */
export function buildRuntimeCommandShimScript(runtime: "docker" | "podman"): string {
  return `#!/bin/sh
__pm_shim_dir="$(CDPATH= cd "$(dirname "$0")" && pwd)"
__pm_new_path=""
__pm_old_ifs="$IFS"
IFS=:
for __pm_path in $PATH; do
  if [ "$__pm_path" = "$__pm_shim_dir" ]; then
    continue
  fi
  __pm_new_path="\${__pm_new_path}\${__pm_new_path:+:}\${__pm_path}"
done
IFS="$__pm_old_ifs"
PATH="$__pm_new_path"
export PATH

${buildComposeProjectRoutingFunctionScript()}

${runtime} "$@"
`;
}

/** Builds wrapper functions that can also be embedded in BASH_ENV restore files. */
export function buildComposeProjectRoutingFunctionScript(): string {
  return `__port_manager_compose_args_have_project() {
  if [ -n "\${COMPOSE_PROJECT_NAME:-}" ]; then
    return 0
  fi

  for __pm_arg in "$@"; do
    case "\${__pm_arg}" in
      -p|--project-name|-p*|--project-name=*)
        return 0
        ;;
    esac
  done

  return 1
}

__port_manager_runtime_first_command() {
  __pm_skip_next=0

  for __pm_arg in "$@"; do
    if [ "\${__pm_skip_next}" = "1" ]; then
      __pm_skip_next=0
      continue
    fi

    case "\${__pm_arg}" in
      --config|--context|-c|--host|-H|--log-level|-l|--tlscacert|--tlscert|--tlskey)
        __pm_skip_next=1
        continue
        ;;
      --config=*|--context=*|--host=*|--log-level=*|--tlscacert=*|--tlscert=*|--tlskey=*)
        continue
        ;;
      --debug|-D|--tls|--tlsverify|--version|-v|--help|-h)
        continue
        ;;
      -*)
        continue
        ;;
    esac

    printf '%s\\n' "\${__pm_arg}"
    return 0
  done

  return 1
}

__port_manager_runtime_container_subcommand() {
  __pm_skip_next=0
  __pm_seen_container=0

  for __pm_arg in "$@"; do
    if [ "\${__pm_skip_next}" = "1" ]; then
      __pm_skip_next=0
      continue
    fi

    if [ "\${__pm_seen_container}" = "0" ]; then
      case "\${__pm_arg}" in
        --config|--context|-c|--host|-H|--log-level|-l|--tlscacert|--tlscert|--tlskey)
          __pm_skip_next=1
          continue
          ;;
        --config=*|--context=*|--host=*|--log-level=*|--tlscacert=*|--tlscert=*|--tlskey=*)
          continue
          ;;
        --debug|-D|--tls|--tlsverify|--version|-v|--help|-h)
          continue
          ;;
        -*)
          continue
          ;;
        container)
          __pm_seen_container=1
          continue
          ;;
        *)
          return 1
          ;;
      esac
    fi

    case "\${__pm_arg}" in
      -*)
        continue
        ;;
    esac

    printf '%s\\n' "\${__pm_arg}"
    return 0
  done

  return 1
}

__port_manager_compose_project_for_runtime() {
  __pm_runtime="$1"
  __pm_file="\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}"
  __pm_network="\${PORT_MANAGER_NETWORK_ID:-\${NEWDLOPS_PM_NETWORK_ID:-}}"
  __pm_best_project=""
  __pm_best_length=0

  if [ -z "\${__pm_file}" ] || [ -z "\${__pm_network}" ] || [ ! -r "\${__pm_file}" ]; then
    return 1
  fi

  while IFS="$(printf '\\t')" read -r __pm_row_kind __pm_row_network __pm_row_runtime __pm_workdir __pm_project __pm_rest; do
    if [ "\${__pm_row_kind}" != "project" ]; then
      continue
    fi

    if [ "\${__pm_row_network}" != "\${__pm_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_runtime}" ]; then
      continue
    fi

    if __port_manager_cwd_matches_workdir "\${__pm_workdir}"; then
      __pm_length=\${#__pm_workdir}
      if [ "\${__pm_length}" -ge "\${__pm_best_length}" ]; then
        __pm_best_length="\${__pm_length}"
        __pm_best_project="\${__pm_project}"
      fi
    fi
  done < "\${__pm_file}"

  if [ -n "\${__pm_best_project}" ]; then
    printf '%s\\n' "\${__pm_best_project}"
    return 0
  fi

  return 1
}

__port_manager_cwd_matches_workdir() {
  __pm_match_workdir="$1"

  case "\${PWD}/" in
    "\${__pm_match_workdir}/"|"\${__pm_match_workdir}/"*)
      return 0
      ;;
  esac

  __pm_match_pwd_physical="$(pwd -P 2>/dev/null || pwd)"
  __pm_match_workdir_physical="$(CDPATH= cd "\${__pm_match_workdir}" 2>/dev/null && pwd -P)"
  if [ -n "\${__pm_match_workdir_physical}" ]; then
    case "\${__pm_match_pwd_physical}/" in
      "\${__pm_match_workdir_physical}/"|"\${__pm_match_workdir_physical}/"*)
        return 0
        ;;
    esac
  fi

  return 1
}

__port_manager_container_target_for_runtime() {
  __pm_runtime="$1"
  __pm_token="$2"
  __pm_file="\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}"
  __pm_network="\${PORT_MANAGER_NETWORK_ID:-\${NEWDLOPS_PM_NETWORK_ID:-}}"
  __pm_matches=0
  __pm_target=""
  __pm_token_length=\${#__pm_token}

  if [ -z "\${__pm_file}" ] || [ -z "\${__pm_network}" ] || [ -z "\${__pm_token}" ] || [ ! -r "\${__pm_file}" ]; then
    return 1
  fi

  __pm_token_suffix=""
  case "\${__pm_token}" in
    *:*)
      __pm_token_suffix=":\${__pm_token#*:}"
      __pm_token="\${__pm_token%%:*}"
      __pm_token_length=\${#__pm_token}
      ;;
  esac

  while IFS="$(printf '\\t')" read -r __pm_row_kind __pm_row_network __pm_row_runtime __pm_workdir __pm_project __pm_original_name __pm_attached_id __pm_attached_name; do
    if [ "\${__pm_row_kind}" != "container" ]; then
      continue
    fi

    if [ "\${__pm_row_network}" != "\${__pm_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_runtime}" ]; then
      continue
    fi

    __pm_matched=0
    if [ "\${__pm_token}" = "\${__pm_original_name}" ]; then
      __pm_matched=1
    elif [ "\${__pm_token_length}" -ge 4 ]; then
      case "\${__pm_project}" in
        "\${__pm_token}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_token}" in
        "\${__pm_project}"*) __pm_matched=1 ;;
      esac
    fi

    if [ "\${__pm_matched}" = "1" ]; then
      __pm_matches=$((__pm_matches + 1))
      __pm_target="\${__pm_attached_id}\${__pm_token_suffix}"
    fi
  done < "\${__pm_file}"

  if [ "\${__pm_matches}" = "1" ] && [ -n "\${__pm_target}" ]; then
    printf '%s\\n' "\${__pm_target}"
    return 0
  fi

  return 1
}

__port_manager_shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

__port_manager_runtime_command_may_reference_container() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"

  case "\${__pm_first_command}" in
    attach|commit|cp|diff|exec|export|inspect|kill|logs|pause|port|rename|restart|rm|start|stats|stop|top|unpause|update|wait)
      return 0
      ;;
    container)
      case "$(__port_manager_runtime_container_subcommand "$@")" in
        attach|commit|cp|diff|exec|export|inspect|kill|logs|pause|port|rename|restart|rm|start|stats|stop|top|unpause|update|wait)
          return 0
          ;;
      esac
      ;;
  esac

  return 1
}

__port_manager_run_runtime_with_container_routing() {
  __pm_runtime="$1"
  shift
  __pm_args=""

  for __pm_arg in "$@"; do
    __pm_mapped="$(__port_manager_container_target_for_runtime "\${__pm_runtime}" "\${__pm_arg}")"
    if [ -n "\${__pm_mapped}" ]; then
      __pm_arg="\${__pm_mapped}"
    fi
    __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
  done

  eval "command \${__pm_runtime}\${__pm_args}"
}

docker() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"
  if [ "\${__pm_first_command}" = "compose" ] && ! __port_manager_compose_args_have_project "$@"; then
    __pm_project="$(__port_manager_compose_project_for_runtime docker)"
    if [ -n "\${__pm_project}" ]; then
      COMPOSE_PROJECT_NAME="\${__pm_project}" command docker "$@"
      return $?
    fi
  fi

  if [ "\${__pm_first_command}" != "compose" ] && __port_manager_runtime_command_may_reference_container "$@"; then
    __port_manager_run_runtime_with_container_routing docker "$@"
    return $?
  fi

  command docker "$@"
}

podman() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"
  if [ "\${__pm_first_command}" = "compose" ] && ! __port_manager_compose_args_have_project "$@"; then
    __pm_project="$(__port_manager_compose_project_for_runtime podman)"
    if [ -n "\${__pm_project}" ]; then
      COMPOSE_PROJECT_NAME="\${__pm_project}" command podman "$@"
      return $?
    fi
  fi

  if [ "\${__pm_first_command}" != "compose" ] && __port_manager_runtime_command_may_reference_container "$@"; then
    __port_manager_run_runtime_with_container_routing podman "$@"
    return $?
  fi

  command podman "$@"
}`;
}

function shellExport(name: string, value: string): string {
  return `export ${name}=${shellQuote(value)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sanitizeField(value: string): string {
  return value.replace(/[\t\r\n]/g, " ").trim();
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
}

function stripContainerNamePrefix(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}
