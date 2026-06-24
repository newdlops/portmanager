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
  /** Compose files that identify the project even when scripts run from another cwd. */
  readonly composeFiles?: readonly string[];
  /** Compose project name that the host shell or scripts would normally target. */
  readonly originalProjectName?: string;
  /** Network-scoped compose project name created by clone attach. */
  readonly attachedProjectName: string;
  /** Direct container id/name rewrites for Docker CLI commands like exec/logs. */
  readonly containerMappings?: readonly ComposeContainerRoutingMapping[];
}

export interface ComposeContainerRoutingMapping {
  /** Compose service name used by lifecycle scripts as a shorthand target. */
  readonly serviceName: string;
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
    const projectFields = [
      "project",
      sanitizeField(row.networkId),
      row.runtime,
      sanitizeField(trimTrailingSlashes(row.workingDirectory)),
      sanitizeField(row.attachedProjectName),
    ];
    if (row.originalProjectName !== undefined) {
      projectFields.push(sanitizeField(row.originalProjectName));
    }
    const baseFields = projectFields.join("\t");
    const composeFileFields = (row.composeFiles ?? []).map((composeFile) =>
      [
        "file",
        sanitizeField(row.networkId),
        row.runtime,
        sanitizeField(composeFile.trim()),
        sanitizeField(row.attachedProjectName),
        sanitizeField(row.originalProjectName ?? ""),
      ].join("\t"),
    );
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
        sanitizeField(mapping.serviceName),
      ].join("\t"),
    );

    return [baseFields, ...composeFileFields, ...containerFields];
  });

  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/** Exports the dynamic map path and installs runtime wrappers in the current shell. */
export function buildComposeProjectRoutingShell(filePath: string, nativeContainerMapPath?: string): string {
  const nativeHelperExport =
    nativeContainerMapPath === undefined ? "" : `${shellExport("PORT_MANAGER_CONTAINER_MAP_HELPER", nativeContainerMapPath)}\n`;

  return `${shellExport("PORT_MANAGER_COMPOSE_ROUTING_FILE", filePath)}
${nativeHelperExport}
${buildComposeProjectRoutingFunctionScript()}`;
}

/** Builds an executable PATH shim for child_process.spawn("docker", ...). */
export type RuntimeCommandShimName = "docker" | "podman" | "docker-compose" | "podman-compose";

export function buildRuntimeCommandShimScript(runtime: RuntimeCommandShimName): string {
  const standaloneCompose =
    runtime === "docker-compose"
      ? `__port_manager_run_standalone_compose_with_routing docker docker-compose "$@"`
      : runtime === "podman-compose"
        ? `__port_manager_run_standalone_compose_with_routing podman podman-compose "$@"`
        : `${runtime} "$@"`;

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

${standaloneCompose}
`;
}

/** Builds wrapper functions that can also be embedded in BASH_ENV restore files. */
export function buildComposeProjectRoutingFunctionScript(): string {
  return `__port_manager_runtime_first_command() {
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

__port_manager_network_id() {
  if [ -n "\${PORT_MANAGER_NETWORK_ID:-}" ]; then
    printf '%s\\n' "\${PORT_MANAGER_NETWORK_ID}"
    return 0
  fi
  if [ -n "\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID:-}" ]; then
    printf '%s\\n' "\${PORT_MANAGER_ROUTE_TABLE_NETWORK_ID}"
    return 0
  fi
  if [ -n "\${PORT_MANAGER_BORROWED_NETWORK_ID:-}" ]; then
    printf '%s\\n' "\${PORT_MANAGER_BORROWED_NETWORK_ID}"
    return 0
  fi
  if [ -n "\${NEWDLOPS_PM_NETWORK_ID:-}" ]; then
    printf '%s\\n' "\${NEWDLOPS_PM_NETWORK_ID}"
    return 0
  fi
  if [ -n "\${NEWDLOPS_PM_BORROWED_NETWORK_ID:-}" ]; then
    printf '%s\\n' "\${NEWDLOPS_PM_BORROWED_NETWORK_ID}"
    return 0
  fi

  __pm_bash_env_path="\${BASH_ENV:-}"
  __pm_bash_env_base="\${__pm_bash_env_path##*/}"
  case "\${__pm_bash_env_base}" in
    portmanager-bash-env-*.sh)
      __pm_bash_network="\${__pm_bash_env_base#portmanager-bash-env-}"
      __pm_bash_network="\${__pm_bash_network%.sh}"
      if [ -n "\${__pm_bash_network}" ]; then
        printf '%s\\n' "\${__pm_bash_network}"
        return 0
      fi
      ;;
  esac

  __pm_routes_path="\${PORT_MANAGER_ROUTES_FILE:-}"
  __pm_routes_base="\${__pm_routes_path##*/}"
  __pm_routes_base="\${__pm_routes_base%.json}"
  case "\${__pm_routes_base}" in
    newdlops-portmanager-routes-*-*)
      __pm_routes_network="\${__pm_routes_base#newdlops-portmanager-routes-}"
      __pm_routes_network="\${__pm_routes_network#*-}"
      if [ -n "\${__pm_routes_network}" ]; then
        printf '%s\\n' "\${__pm_routes_network}"
        return 0
      fi
      ;;
  esac

  return 1
}

__port_manager_normalize_compose_file_path() {
  __pm_file_path="$1"
  case "\${__pm_file_path}" in
    /*)
      ;;
    *)
      __pm_file_path="\${PWD}/\${__pm_file_path}"
      ;;
  esac

  __pm_file_dir="\${__pm_file_path%/*}"
  __pm_file_base="\${__pm_file_path##*/}"
  __pm_physical_dir="$(CDPATH= cd "\${__pm_file_dir}" 2>/dev/null && pwd -P)"
  if [ -n "\${__pm_physical_dir}" ]; then
    printf '%s/%s\\n' "\${__pm_physical_dir}" "\${__pm_file_base}"
    return 0
  fi

  printf '%s\\n' "\${__pm_file_path}"
}

__port_manager_same_compose_file_path() {
  __pm_left="$(__port_manager_normalize_compose_file_path "$1")"
  __pm_right="$(__port_manager_normalize_compose_file_path "$2")"
  [ "\${__pm_left}" = "\${__pm_right}" ]
}

__port_manager_compose_args_reference_file() {
  __pm_expected_file="$1"
  shift
  __pm_next_is_file=0

  for __pm_arg in "$@"; do
    if [ "\${__pm_next_is_file}" = "1" ]; then
      __pm_next_is_file=0
      if __port_manager_same_compose_file_path "\${__pm_expected_file}" "\${__pm_arg}"; then
        return 0
      fi
      continue
    fi

    case "\${__pm_arg}" in
      -f|--file)
        __pm_next_is_file=1
        continue
        ;;
      --file=*)
        if __port_manager_same_compose_file_path "\${__pm_expected_file}" "\${__pm_arg#--file=}"; then
          return 0
        fi
        ;;
      -f?*)
        if __port_manager_same_compose_file_path "\${__pm_expected_file}" "\${__pm_arg#-f}"; then
          return 0
        fi
        ;;
    esac
  done

  return 1
}

__port_manager_compose_route_for_runtime() {
  __pm_runtime="$1"
  shift
  __pm_file="\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}"
  __pm_network="$(__port_manager_network_id)"
  __pm_best_attached_project=""
  __pm_best_original_project=""
  __pm_best_length=0

  if [ -z "\${__pm_file}" ] || [ -z "\${__pm_network}" ] || [ ! -r "\${__pm_file}" ]; then
    return 1
  fi

  while IFS="$(printf '\\t')" read -r __pm_row_kind __pm_row_network __pm_row_runtime __pm_workdir __pm_attached_project __pm_original_project __pm_rest; do
    if [ "\${__pm_row_network}" != "\${__pm_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_runtime}" ]; then
      continue
    fi

    __pm_row_matches=0
    if [ "\${__pm_row_kind}" = "project" ] && __port_manager_cwd_matches_workdir "\${__pm_workdir}"; then
      __pm_row_matches=1
    elif [ "\${__pm_row_kind}" = "file" ] && __port_manager_compose_args_reference_file "\${__pm_workdir}" "$@"; then
      __pm_row_matches=1
    fi

    if [ "\${__pm_row_matches}" = "1" ]; then
      __pm_length=\${#__pm_workdir}
      if [ "\${__pm_length}" -ge "\${__pm_best_length}" ]; then
        __pm_best_length="\${__pm_length}"
        __pm_best_attached_project="\${__pm_attached_project}"
        __pm_best_original_project="\${__pm_original_project}"
      fi
    fi
  done < "\${__pm_file}"

  if [ -n "\${__pm_best_attached_project}" ]; then
    printf '%s\\t%s\\n' "\${__pm_best_attached_project}" "\${__pm_best_original_project}"
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
  __pm_network="$(__port_manager_network_id)"
  __pm_matches=0
  __pm_target=""
  __pm_token_length=\${#__pm_token}

  if [ -z "\${__pm_file}" ] || [ -z "\${__pm_network}" ] || [ -z "\${__pm_token}" ] || [ ! -r "\${__pm_file}" ]; then
    return 1
  fi

  __pm_helper="\${PORT_MANAGER_CONTAINER_MAP_HELPER:-}"
  if [ -n "\${__pm_helper}" ] && [ -x "\${__pm_helper}" ]; then
    __pm_mapped="$("\${__pm_helper}" "\${__pm_file}" "\${__pm_network}" "\${__pm_runtime}" "\${__pm_token}" 2>/dev/null || true)"
    if [ -n "\${__pm_mapped}" ]; then
      printf '%s\\n' "\${__pm_mapped}"
      return 0
    fi
  fi

  __pm_token_suffix=""
  case "\${__pm_token}" in
    *:*)
      __pm_token_suffix=":\${__pm_token#*:}"
      __pm_token="\${__pm_token%%:*}"
      __pm_token_length=\${#__pm_token}
      ;;
  esac

  while IFS="$(printf '\\t')" read -r __pm_row_kind __pm_row_network __pm_row_runtime __pm_workdir __pm_project __pm_original_name __pm_attached_id __pm_attached_name __pm_service_name; do
    if [ "\${__pm_row_kind}" != "container" ]; then
      continue
    fi

    if [ "\${__pm_row_network}" != "\${__pm_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_runtime}" ]; then
      continue
    fi

    __pm_matched=0
    if [ "\${__pm_token}" = "\${__pm_original_name}" ] || [ "\${__pm_token}" = "\${__pm_attached_name}" ] || [ "\${__pm_token}" = "\${__pm_service_name}" ]; then
      __pm_matched=1
    elif [ "\${__pm_token_length}" -ge 4 ]; then
      case "\${__pm_project}" in
        "\${__pm_token}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_token}" in
        "\${__pm_project}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_attached_id}" in
        "\${__pm_token}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_token}" in
        "\${__pm_attached_id}"*) __pm_matched=1 ;;
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

__port_manager_run_compose_command_with_routing() {
  __pm_route_runtime="$1"
  __pm_command="$2"
  __pm_standalone_compose="$3"
  shift 3
  __pm_route="$(__port_manager_compose_route_for_runtime "\${__pm_route_runtime}" "$@")"
  if [ -z "\${__pm_route}" ]; then
    command "\${__pm_command}" "$@"
    return $?
  fi

  __pm_tab="$(printf '\\t')"
  __pm_attached_project="\${__pm_route%%\${__pm_tab}*}"
  __pm_args=""
  __pm_rewrite_next=0

  for __pm_arg in "$@"; do
    if [ "\${__pm_rewrite_next}" = "1" ]; then
      __pm_arg="\${__pm_attached_project}"
      __pm_rewrite_next=0
      __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
      continue
    fi

    case "\${__pm_arg}" in
      -p|--project-name)
        __pm_rewrite_next=1
        __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
        continue
        ;;
      --project-name=*)
        __pm_arg="--project-name=\${__pm_attached_project}"
        ;;
      -p?*)
        __pm_arg="-p\${__pm_attached_project}"
        ;;
    esac

    __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
  done

  (COMPOSE_PROJECT_NAME="\${__pm_attached_project}"; export COMPOSE_PROJECT_NAME; eval "command \${__pm_command}\${__pm_args}")
}

__port_manager_run_runtime_with_compose_routing() {
  __pm_runtime="$1"
  shift
  __port_manager_run_compose_command_with_routing "\${__pm_runtime}" "\${__pm_runtime}" 0 "$@"
}

__port_manager_run_standalone_compose_with_routing() {
  __pm_route_runtime="$1"
  __pm_command="$2"
  shift 2
  __port_manager_run_compose_command_with_routing "\${__pm_route_runtime}" "\${__pm_command}" 1 "$@"
}

docker() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"
  if [ "\${__pm_first_command}" = "compose" ]; then
    __port_manager_run_runtime_with_compose_routing docker "$@"
    return $?
  fi

  if [ "\${__pm_first_command}" != "compose" ] && __port_manager_runtime_command_may_reference_container "$@"; then
    __port_manager_run_runtime_with_container_routing docker "$@"
    return $?
  fi

  command docker "$@"
}

podman() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"
  if [ "\${__pm_first_command}" = "compose" ]; then
    __port_manager_run_runtime_with_compose_routing podman "$@"
    return $?
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
