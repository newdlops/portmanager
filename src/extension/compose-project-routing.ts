import * as fs from "node:fs";

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
  /** Generated override that removes host-visible ports and rewrites global container names. */
  readonly overrideFile?: string;
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

export interface ComposeRoutingFileSet {
  /** User-authored compose files that identify the original project. */
  readonly composeFiles: readonly string[];
  /** Port Manager-generated override that hides host ports and rewrites names. */
  readonly overrideFile?: string;
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
    if (row.originalProjectName !== undefined || row.overrideFile !== undefined) {
      projectFields.push(sanitizeField(row.originalProjectName ?? ""));
    }
    if (row.overrideFile !== undefined) {
      projectFields.push(sanitizeField(row.overrideFile));
    }
    const baseFields = projectFields.join("\t");
    const composeFileFields = (row.composeFiles ?? []).map((composeFile) => {
      const fields = [
        "file",
        sanitizeField(row.networkId),
        row.runtime,
        sanitizeField(composeFile.trim()),
        sanitizeField(row.attachedProjectName),
        sanitizeField(row.originalProjectName ?? ""),
      ];
      if (row.overrideFile !== undefined) {
        fields.push(sanitizeField(row.overrideFile));
      }
      return fields.join("\t");
    });
    const containerFields = buildContainerRoutingRows(row);

    return [baseFields, ...composeFileFields, ...containerFields];
  });

  return `${lines.join("\n")}${lines.length > 0 ? "\n" : ""}`;
}

/**
 * Splits a persisted compose file list into source files and the generated
 * Port Manager override. Older as-is clone attachments can persist both in one
 * array without a mutation object, but shell routing needs the override as a
 * distinct field so future compose commands keep the hidden-port project shape.
 */
export function splitGeneratedComposeRoutingFiles(composeFiles: readonly string[]): ComposeRoutingFileSet {
  const sourceFiles: string[] = [];
  let overrideFile: string | undefined;

  for (const composeFile of composeFiles) {
    if (isGeneratedComposeRoutingOverrideFile(composeFile)) {
      overrideFile = composeFile;
      continue;
    }

    sourceFiles.push(composeFile);
  }

  return {
    composeFiles: sourceFiles.length > 0 ? sourceFiles : composeFiles,
    ...(overrideFile !== undefined ? { overrideFile } : {}),
  };
}

/**
 * Recovers container-name rewrites for persisted clone/as-is attachments that
 * have no mutation state. The generated override either contains an explicit
 * attached name or resets a source container_name so Compose can generate the
 * hidden project-scoped name. Source compose files preserve hardcoded names
 * such as captain_db so direct Docker commands can keep using them.
 */
export function inferContainerMappingsFromComposeRoutingFiles(input: {
  readonly attachedProjectName: string;
  readonly composeFiles: readonly string[];
  readonly serviceNames: readonly string[];
}): readonly ComposeContainerRoutingMapping[] {
  const overrideContainerNames = readGeneratedOverrideContainerNameState(input.composeFiles);
  const sourceContainerNames = readSourceComposeContainerNames(input.composeFiles);
  const serviceNames = uniqueStrings([
    ...input.serviceNames,
    ...overrideContainerNames.names.keys(),
    ...sourceContainerNames.keys(),
  ]);
  if (serviceNames.length === 0 || overrideContainerNames.names.size === 0) {
    return [];
  }

  return serviceNames.map((serviceName) => {
    const attachedContainerName =
      overrideContainerNames.names.get(serviceName) ?? defaultComposeContainerName(input.attachedProjectName, serviceName);
    const originalContainerName =
      sourceContainerNames.get(serviceName) ??
      inferOriginalContainerName(attachedContainerName, input.attachedProjectName) ?? serviceName;

    return {
      serviceName,
      originalContainerId: originalContainerName,
      originalContainerName,
      attachedContainerId: attachedContainerName,
      attachedContainerName,
    };
  });
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

__port_manager_path_basename() {
  __pm_path_value="$1"
  while [ "\${__pm_path_value}" != "/" ]; do
    case "\${__pm_path_value}" in
      */) __pm_path_value="\${__pm_path_value%/}" ;;
      *) break ;;
    esac
  done

  __pm_path_value="\${__pm_path_value##*/}"
  if [ -n "\${__pm_path_value}" ]; then
    printf '%s\\n' "\${__pm_path_value}"
    return 0
  fi

  return 1
}

__port_manager_compose_project_name_from_directory() {
  __pm_project_dir="$1"
  case "\${__pm_project_dir}" in
    /*) ;;
    *) __pm_project_dir="\${PWD}/\${__pm_project_dir}" ;;
  esac

  __pm_project_dir_physical="$(CDPATH= cd "\${__pm_project_dir}" 2>/dev/null && pwd -P)"
  __port_manager_path_basename "\${__pm_project_dir_physical:-\${__pm_project_dir}}"
}

__port_manager_compose_project_name_from_file() {
  __pm_project_file="$(__port_manager_normalize_compose_file_path "$1")"
  __pm_project_file_dir="\${__pm_project_file%/*}"
  __port_manager_compose_project_name_from_directory "\${__pm_project_file_dir}"
}

__port_manager_compose_requested_project_name() {
  __pm_next_is_project=0
  __pm_next_is_file=0
  __pm_next_is_project_dir=0
  __pm_first_file=""
  __pm_project_dir=""

  for __pm_arg in "$@"; do
    if [ "\${__pm_next_is_project}" = "1" ]; then
      printf '%s\\n' "\${__pm_arg}"
      return 0
    fi

    if [ "\${__pm_next_is_file}" = "1" ]; then
      __pm_next_is_file=0
      if [ -z "\${__pm_first_file}" ]; then
        __pm_first_file="\${__pm_arg}"
      fi
      continue
    fi

    if [ "\${__pm_next_is_project_dir}" = "1" ]; then
      __pm_next_is_project_dir=0
      __pm_project_dir="\${__pm_arg}"
      continue
    fi

    case "\${__pm_arg}" in
      -p|--project-name)
        __pm_next_is_project=1
        continue
        ;;
      --project-name=*)
        printf '%s\\n' "\${__pm_arg#--project-name=}"
        return 0
        ;;
      -p?*)
        printf '%s\\n' "\${__pm_arg#-p}"
        return 0
        ;;
      -f|--file)
        __pm_next_is_file=1
        continue
        ;;
      --file=*)
        if [ -z "\${__pm_first_file}" ]; then
          __pm_first_file="\${__pm_arg#--file=}"
        fi
        ;;
      -f?*)
        if [ -z "\${__pm_first_file}" ]; then
          __pm_first_file="\${__pm_arg#-f}"
        fi
        ;;
      --project-directory)
        __pm_next_is_project_dir=1
        continue
        ;;
      --project-directory=*)
        __pm_project_dir="\${__pm_arg#--project-directory=}"
        ;;
    esac
  done

  if [ -n "\${COMPOSE_PROJECT_NAME:-}" ]; then
    printf '%s\\n' "\${COMPOSE_PROJECT_NAME}"
    return 0
  fi

  if [ -n "\${__pm_project_dir}" ]; then
    __port_manager_compose_project_name_from_directory "\${__pm_project_dir}" && return 0
  fi

  if [ -n "\${__pm_first_file}" ]; then
    __port_manager_compose_project_name_from_file "\${__pm_first_file}" && return 0
  fi

  __port_manager_compose_project_name_from_directory "\${PWD}"
}

__port_manager_tsv_take() {
  __pm_tsv_input="$1"
  __pm_tsv_tab="$(printf '\\t')"
  case "\${__pm_tsv_input}" in
    *"\${__pm_tsv_tab}"*)
      __pm_tsv_field="\${__pm_tsv_input%%"\${__pm_tsv_tab}"*}"
      __pm_tsv_rest="\${__pm_tsv_input#*"\${__pm_tsv_tab}"}"
      ;;
    *)
      __pm_tsv_field="\${__pm_tsv_input}"
      __pm_tsv_rest=""
      ;;
  esac
}

__port_manager_parse_project_routing_row() {
  __pm_parse_rest="$1"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_kind="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_network="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_runtime="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_workdir="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_project="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_original="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __pm_row_rest="\${__pm_parse_rest}"
}

__port_manager_parse_container_routing_row() {
  __pm_parse_rest="$1"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_kind="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_network="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_row_runtime="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_workdir="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_project="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_original_name="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_attached_id="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __port_manager_tsv_take "\${__pm_parse_rest}"; __pm_attached_name="\${__pm_tsv_field}"; __pm_parse_rest="\${__pm_tsv_rest}"
  __pm_service_name="\${__pm_parse_rest}"
}

__port_manager_compose_route_scan_file_for_runtime() {
  __pm_scan_file="$1"
  __pm_scan_runtime="$2"
  __pm_scan_network="$3"
  shift 3

  [ -r "\${__pm_scan_file}" ] || return 1
  while IFS= read -r __pm_line || [ -n "\${__pm_line}" ]; do
    __port_manager_parse_project_routing_row "\${__pm_line}"
    __pm_attached_project="\${__pm_row_project}"
    __pm_original_project="\${__pm_row_original}"
    __pm_row_override_file="\${__pm_row_rest}"
    if [ "\${__pm_row_network}" != "\${__pm_scan_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_scan_runtime}" ]; then
      continue
    fi
    if [ "\${__pm_row_kind}" = "project" ] && [ -z "\${__pm_original_project}" ]; then
      __pm_original_project="$(__port_manager_compose_project_name_from_directory "\${__pm_workdir}" 2>/dev/null || true)"
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
        __pm_best_override_file="\${__pm_row_override_file}"
      fi
    elif [ "\${__pm_row_kind}" = "project" ] && [ -n "\${__pm_requested_project}" ]; then
      if [ "\${__pm_requested_project}" = "\${__pm_original_project}" ] || [ "\${__pm_requested_project}" = "\${__pm_attached_project}" ]; then
        __pm_project_match_count=$((__pm_project_match_count + 1))
        __pm_project_attached_project="\${__pm_attached_project}"
        __pm_project_original_project="\${__pm_original_project}"
        __pm_project_override_file="\${__pm_row_override_file}"
      fi
    fi
  done < "\${__pm_scan_file}"

  return 0
}

__port_manager_compose_route_for_runtime() {
  __pm_runtime="$1"
  shift
  __pm_file="\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}"
  __pm_network="$(__port_manager_network_id)"
  __pm_best_attached_project=""
  __pm_best_original_project=""
  __pm_best_override_file=""
  __pm_best_length=0
  __pm_requested_project="$(__port_manager_compose_requested_project_name "$@" 2>/dev/null || true)"
  __pm_project_match_count=0
  __pm_project_attached_project=""
  __pm_project_original_project=""
  __pm_project_override_file=""

  if [ -z "\${__pm_file}" ] || [ -z "\${__pm_network}" ]; then
    return 1
  fi

  case "\${__pm_file}" in
    */*) __pm_file_dir="\${__pm_file%/*}" ;;
    *) __pm_file_dir="." ;;
  esac
  __pm_file_base="\${__pm_file##*/}"
  __pm_file_stem="\${__pm_file_base%.tsv}"
  __pm_scoped_files=0

  case "\${__pm_file_base}" in
    compose-project-routing-*.tsv)
      for __pm_scoped_file in "\${__pm_file_dir}/\${__pm_file_stem}.compose-"*.tsv; do
        [ -r "\${__pm_scoped_file}" ] || continue
        __pm_scoped_files=1
        __port_manager_compose_route_scan_file_for_runtime "\${__pm_scoped_file}" "\${__pm_runtime}" "\${__pm_network}" "$@"
      done
      ;;
  esac

  if [ "\${__pm_scoped_files}" = "1" ]; then
    if [ -z "\${__pm_best_attached_project}" ] && [ "\${__pm_project_match_count}" = "0" ]; then
      __port_manager_compose_route_scan_file_for_runtime "\${__pm_file}" "\${__pm_runtime}" "\${__pm_network}" "$@" || true
    fi
  else
    __port_manager_compose_route_scan_file_for_runtime "\${__pm_file}" "\${__pm_runtime}" "\${__pm_network}" "$@" || return 1
  fi

  if [ -n "\${__pm_best_attached_project}" ]; then
    printf '%s\\t%s\\t%s\\n' "\${__pm_best_attached_project}" "\${__pm_best_original_project}" "\${__pm_best_override_file}"
    return 0
  fi

  if [ "\${__pm_project_match_count}" = "1" ] && [ -n "\${__pm_project_attached_project}" ]; then
    printf '%s\\t%s\\t%s\\n' "\${__pm_project_attached_project}" "\${__pm_project_original_project}" "\${__pm_project_override_file}"
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
    *)
      case "\${__pm_match_workdir}/" in
        "\${PWD}/"|"\${PWD}/"*)
          return 0
          ;;
      esac
      ;;
  esac

  __pm_match_pwd_physical="$(pwd -P 2>/dev/null || pwd)"
  __pm_match_workdir_physical="$(CDPATH= cd "\${__pm_match_workdir}" 2>/dev/null && pwd -P)"
  if [ -n "\${__pm_match_workdir_physical}" ]; then
    case "\${__pm_match_pwd_physical}/" in
      "\${__pm_match_workdir_physical}/"|"\${__pm_match_workdir_physical}/"*)
        return 0
        ;;
      *)
        case "\${__pm_match_workdir_physical}/" in
          "\${__pm_match_pwd_physical}/"|"\${__pm_match_pwd_physical}/"*)
            return 0
            ;;
        esac
        ;;
    esac
  fi

  return 1
}

__port_manager_compose_routing_file_matches_context() {
  __pm_context_file="$1"
  __pm_context_runtime="$2"
  __pm_context_network="$3"
  shift 3

  [ -r "\${__pm_context_file}" ] || return 1
  __pm_context_project="$(__port_manager_compose_requested_project_name "$@" 2>/dev/null || true)"
  while IFS= read -r __pm_line || [ -n "\${__pm_line}" ]; do
    __port_manager_parse_project_routing_row "\${__pm_line}"
    __pm_context_attached="\${__pm_row_project}"
    __pm_context_original="\${__pm_row_original}"
    __pm_context_rest="\${__pm_row_rest}"
    if [ "\${__pm_row_network}" != "\${__pm_context_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_context_runtime}" ]; then
      continue
    fi
    if [ "\${__pm_row_kind}" = "project" ] && [ -z "\${__pm_context_original}" ]; then
      __pm_context_original="$(__port_manager_compose_project_name_from_directory "\${__pm_workdir}" 2>/dev/null || true)"
    fi

    if [ "\${__pm_row_kind}" = "project" ] && __port_manager_cwd_matches_workdir "\${__pm_workdir}"; then
      return 0
    fi

    if [ "\${__pm_row_kind}" = "project" ] && [ -n "\${__pm_context_project}" ]; then
      if [ "\${__pm_context_project}" = "\${__pm_context_original}" ] || [ "\${__pm_context_project}" = "\${__pm_context_attached}" ]; then
        return 0
      fi
    fi

    if [ "\${__pm_row_kind}" = "file" ] && __port_manager_compose_args_reference_file "\${__pm_workdir}" "$@"; then
      return 0
    fi
  done < "\${__pm_context_file}"

  return 1
}

__port_manager_container_target_scan_file_for_runtime() {
  __pm_scan_file="$1"
  __pm_scan_runtime="$2"
  __pm_scan_network="$3"
  __pm_scan_token="$4"
  __pm_scan_token_length="$5"
  __pm_scan_suffix="$6"

  [ -r "\${__pm_scan_file}" ] || return 1
  while IFS= read -r __pm_line || [ -n "\${__pm_line}" ]; do
    __port_manager_parse_container_routing_row "\${__pm_line}"
    if [ "\${__pm_row_kind}" != "container" ]; then
      continue
    fi

    if [ "\${__pm_row_network}" != "\${__pm_scan_network}" ] || [ "\${__pm_row_runtime}" != "\${__pm_scan_runtime}" ]; then
      continue
    fi

    __pm_matched=0
    if [ "\${__pm_scan_token}" = "\${__pm_original_name}" ] || [ "\${__pm_scan_token}" = "\${__pm_attached_name}" ] || [ "\${__pm_scan_token}" = "\${__pm_service_name}" ]; then
      __pm_matched=1
    elif [ "\${__pm_scan_token_length}" -ge 4 ]; then
      case "\${__pm_project}" in
        "\${__pm_scan_token}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_scan_token}" in
        "\${__pm_project}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_attached_id}" in
        "\${__pm_scan_token}"*) __pm_matched=1 ;;
      esac
      case "\${__pm_scan_token}" in
        "\${__pm_attached_id}"*) __pm_matched=1 ;;
      esac
    fi

    if [ "\${__pm_matched}" = "1" ]; then
      __pm_next_service="\${__pm_service_name}"
      __pm_next_priority=1
      case "\${__pm_next_service}" in
        __portmanager_alias__:*)
          __pm_next_service="\${__pm_next_service#__portmanager_alias__:}"
          __pm_next_priority=3
          ;;
      esac
      if [ -n "\${__pm_attached_name}" ]; then
        __pm_next_target_base="\${__pm_attached_name}"
      else
        __pm_next_target_base="\${__pm_attached_id}"
      fi
      __pm_next_target="\${__pm_next_target_base}\${__pm_scan_suffix}"
      if [ -z "\${__pm_target}" ]; then
        __pm_target="\${__pm_next_target}"
        __pm_target_base="\${__pm_next_target_base}"
        __pm_target_service="\${__pm_next_service}"
        __pm_target_priority="\${__pm_next_priority}"
        __pm_matches=$((__pm_matches + 1))
      elif [ "\${__pm_next_priority}" -gt "\${__pm_target_priority:-0}" ] 2>/dev/null; then
        __pm_target="\${__pm_next_target}"
        __pm_target_base="\${__pm_next_target_base}"
        __pm_target_service="\${__pm_next_service}"
        __pm_target_priority="\${__pm_next_priority}"
        __pm_matches=1
      elif [ "\${__pm_next_priority}" -lt "\${__pm_target_priority:-0}" ] 2>/dev/null; then
        :
      elif [ "\${__pm_target}" != "\${__pm_next_target}" ]; then
        __pm_target="\${__pm_next_target}"
        __pm_target_base="\${__pm_next_target_base}"
        __pm_target_service="\${__pm_next_service}"
        __pm_matches=$((__pm_matches + 1))
      elif [ -z "\${__pm_target_service}" ] && [ -n "\${__pm_next_service}" ]; then
        __pm_target_service="\${__pm_next_service}"
      fi
    fi
  done < "\${__pm_scan_file}"

  return 0
}

__port_manager_container_target_helper_scan_file_for_runtime() {
  __pm_scan_file="$1"
  __pm_scan_runtime="$2"
  __pm_scan_network="$3"
  __pm_scan_token="$4"

  [ -n "\${__pm_helper}" ] && [ -x "\${__pm_helper}" ] && [ -r "\${__pm_scan_file}" ] || return 1
  __pm_mapped="$("\${__pm_helper}" "\${__pm_scan_file}" "\${__pm_scan_network}" "\${__pm_scan_runtime}" "\${__pm_scan_token}" 2>/dev/null || true)"
  if [ -n "\${__pm_mapped}" ]; then
    if [ -z "\${__pm_helper_target}" ]; then
      __pm_helper_matches=1
      __pm_helper_target="\${__pm_mapped}"
    elif [ "\${__pm_helper_target}" != "\${__pm_mapped}" ]; then
      __pm_helper_matches=$((__pm_helper_matches + 1))
      __pm_helper_target="\${__pm_mapped}"
    fi
  fi

  return 0
}

__port_manager_container_target_is_running() {
  __pm_running_runtime="$1"
  __pm_running_target="$2"
  [ -n "\${__pm_running_runtime}" ] && [ -n "\${__pm_running_target}" ] || { unset __pm_running_runtime __pm_running_target; return 1; }
  __pm_running_state="$(command "\${__pm_running_runtime}" inspect --format '{{.State.Running}}' "\${__pm_running_target}" 2>/dev/null | sed -n '1p' || true)"
  [ "\${__pm_running_state}" = "true" ]
  __pm_running_status=$?
  unset __pm_running_runtime __pm_running_target __pm_running_state
  return \${__pm_running_status}
}

__port_manager_compose_service_live_container() {
  __pm_service_runtime="$1"
  __pm_service_project="$2"
  __pm_service_name="$3"
  [ -n "\${__pm_service_runtime}" ] && [ -n "\${__pm_service_project}" ] && [ -n "\${__pm_service_name}" ] || {
    unset __pm_service_runtime __pm_service_project __pm_service_name
    return 1
  }
  __pm_service_output="$(command "\${__pm_service_runtime}" compose -p "\${__pm_service_project}" ps -q "\${__pm_service_name}" 2>/dev/null | sed -n '/./p' | sed -n '1,2p' || true)"
  __pm_service_first="$(printf '%s\\n' "\${__pm_service_output}" | sed -n '1p')"
  __pm_service_second="$(printf '%s\\n' "\${__pm_service_output}" | sed -n '2p')"
  if [ -n "\${__pm_service_first}" ] && [ -z "\${__pm_service_second}" ]; then
    printf '%s\\n' "\${__pm_service_first}"
    unset __pm_service_runtime __pm_service_project __pm_service_name __pm_service_output __pm_service_first __pm_service_second
    return 0
  fi
  unset __pm_service_runtime __pm_service_project __pm_service_name __pm_service_output __pm_service_first __pm_service_second
  return 1
}

__port_manager_print_live_container_target() {
  __pm_live_runtime="$1"
  __pm_live_target="$2"
  __pm_live_suffix="$3"
  __pm_live_service="$4"
  shift 4
  [ -n "\${__pm_live_target}" ] || { unset __pm_live_runtime __pm_live_target __pm_live_suffix __pm_live_service; return 1; }
  if __port_manager_container_target_is_running "\${__pm_live_runtime}" "\${__pm_live_target}"; then
    printf '%s%s\\n' "\${__pm_live_target}" "\${__pm_live_suffix}"
    unset __pm_live_runtime __pm_live_target __pm_live_suffix __pm_live_service
    return 0
  fi
  __pm_live_route="$(__port_manager_compose_route_for_runtime "\${__pm_live_runtime}" "$@" 2>/dev/null || true)"
  if [ -n "\${__pm_live_route}" ] && [ -n "\${__pm_live_service}" ]; then
    __pm_live_tab="$(printf '\\t')"
    __pm_live_project="\${__pm_live_route%%\${__pm_live_tab}*}"
    __pm_live_current="$(__port_manager_compose_service_live_container "\${__pm_live_runtime}" "\${__pm_live_project}" "\${__pm_live_service}" 2>/dev/null || true)"
    if [ -n "\${__pm_live_current}" ]; then
      printf '%s%s\\n' "\${__pm_live_current}" "\${__pm_live_suffix}"
      unset __pm_live_runtime __pm_live_target __pm_live_suffix __pm_live_service __pm_live_route __pm_live_tab __pm_live_project __pm_live_current
      return 0
    fi
  fi
  printf '%s%s\\n' "\${__pm_live_target}" "\${__pm_live_suffix}"
  unset __pm_live_runtime __pm_live_target __pm_live_suffix __pm_live_service __pm_live_route __pm_live_tab __pm_live_project __pm_live_current
  return 0
}

__port_manager_container_target_for_runtime() {
  __pm_runtime="$1"
  __pm_token="$2"
  shift 2
  __pm_file="\${PORT_MANAGER_COMPOSE_ROUTING_FILE:-}"
  __pm_network="$(__port_manager_network_id)"
  __pm_matches=0
  __pm_target=""
  __pm_target_base=""
  __pm_target_service=""
  __pm_target_priority=0
  __pm_token_length=\${#__pm_token}

  if [ -z "\${__pm_file}" ] || [ -z "\${__pm_network}" ] || [ -z "\${__pm_token}" ]; then
    return 1
  fi

  __pm_helper="\${PORT_MANAGER_CONTAINER_MAP_HELPER:-}"
  __pm_token_suffix=""
  case "\${__pm_token}" in
    *:*)
      __pm_token_suffix=":\${__pm_token#*:}"
      __pm_token="\${__pm_token%%:*}"
      __pm_token_length=\${#__pm_token}
      ;;
  esac

  case "\${__pm_file}" in
    */*) __pm_file_dir="\${__pm_file%/*}" ;;
    *) __pm_file_dir="." ;;
  esac
  __pm_file_base="\${__pm_file##*/}"
  __pm_file_stem="\${__pm_file_base%.tsv}"
  __pm_scoped_files=0
  __pm_context_files=0
  __pm_helper_matches=0
  __pm_helper_target=""

  case "\${__pm_file_base}" in
    compose-project-routing-*.tsv)
      for __pm_scoped_file in "\${__pm_file_dir}/\${__pm_file_stem}.compose-"*.tsv; do
        [ -r "\${__pm_scoped_file}" ] || continue
        __pm_scoped_files=1
        if __port_manager_compose_routing_file_matches_context "\${__pm_scoped_file}" "\${__pm_runtime}" "\${__pm_network}" "$@"; then
          __pm_context_files=$((__pm_context_files + 1))
          __port_manager_container_target_helper_scan_file_for_runtime "\${__pm_scoped_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}"
          __port_manager_container_target_scan_file_for_runtime "\${__pm_scoped_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}" "\${__pm_token_length}" "\${__pm_token_suffix}"
        fi
      done
      ;;
  esac

  if [ "\${__pm_context_files}" != "0" ]; then
    if [ "\${__pm_matches}" = "1" ] && [ -n "\${__pm_target}" ]; then
      __port_manager_print_live_container_target "\${__pm_runtime}" "\${__pm_target_base}" "\${__pm_token_suffix}" "\${__pm_target_service}" "$@"
      return $?
    fi
    if [ "\${__pm_helper_matches}" = "1" ] && [ -n "\${__pm_helper_target}" ]; then
      __port_manager_print_live_container_target "\${__pm_runtime}" "\${__pm_helper_target}" "\${__pm_token_suffix}" "\${__pm_target_service}" "$@"
      return $?
    fi
    return 1
  fi

  if [ "\${__pm_scoped_files}" = "1" ]; then
    __pm_matches=0
    __pm_target=""
    __pm_target_base=""
    __pm_target_service=""
    __pm_target_priority=0
    __pm_helper_matches=0
    __pm_helper_target=""
    for __pm_scoped_file in "\${__pm_file_dir}/\${__pm_file_stem}.compose-"*.tsv; do
      [ -r "\${__pm_scoped_file}" ] || continue
      __port_manager_container_target_helper_scan_file_for_runtime "\${__pm_scoped_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}"
      __port_manager_container_target_scan_file_for_runtime "\${__pm_scoped_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}" "\${__pm_token_length}" "\${__pm_token_suffix}"
    done
    if [ "\${__pm_matches}" = "0" ] && [ "\${__pm_helper_matches}" = "0" ]; then
      __port_manager_container_target_helper_scan_file_for_runtime "\${__pm_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}"
      __port_manager_container_target_scan_file_for_runtime "\${__pm_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}" "\${__pm_token_length}" "\${__pm_token_suffix}" || true
    fi
  else
    __port_manager_container_target_helper_scan_file_for_runtime "\${__pm_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}"
    __port_manager_container_target_scan_file_for_runtime "\${__pm_file}" "\${__pm_runtime}" "\${__pm_network}" "\${__pm_token}" "\${__pm_token_length}" "\${__pm_token_suffix}" || return 1
  fi

  if [ "\${__pm_matches}" = "1" ] && [ -n "\${__pm_target}" ]; then
    __port_manager_print_live_container_target "\${__pm_runtime}" "\${__pm_target_base}" "\${__pm_token_suffix}" "\${__pm_target_service}" "$@"
    return $?
  fi

  if [ "\${__pm_helper_matches}" = "1" ] && [ -n "\${__pm_helper_target}" ]; then
    __port_manager_print_live_container_target "\${__pm_runtime}" "\${__pm_helper_target}" "\${__pm_token_suffix}" "\${__pm_target_service}" "$@"
    return $?
  fi

  return 1
}

__port_manager_shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\\\\\''/g"
  printf "'"
}

__port_manager_signal_terminal_attachment_changed() {
  [ -n "\${PORT_MANAGER_TERMINAL_ATTACHMENT_DIR:-}" ] || return 0
  __pm_signal_network="$(__port_manager_network_id)"
  [ -n "\${__pm_signal_network}" ] || { unset __pm_signal_network; return 0; }
  mkdir -p "\${PORT_MANAGER_TERMINAL_ATTACHMENT_DIR}" 2>/dev/null || true
  __pm_signal_tty="$(tty 2>/dev/null || true)"
  __pm_signal_tty="\${__pm_signal_tty#/dev/}"
  if [ "\${__pm_signal_tty}" = "not a tty" ]; then __pm_signal_tty=""; fi
  __pm_signal_pid="$$"
  __pm_signal_pgid="$(ps -o pgid= -p "$$" 2>/dev/null | tr -d " " || true)"
  __pm_signal_identity="\${PORT_MANAGER_TERMINAL_SESSION_ID:-\${__pm_signal_tty:-pid-$__pm_signal_pid}}"
  __pm_signal_key="$(printf '%s' "\${__pm_signal_identity}" | sed 's#[^A-Za-z0-9._-]#_#g')"
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${__pm_signal_network}" "\${__pm_signal_tty}" "\${__pm_signal_pid}" "\${__pm_signal_pgid}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')" "\${PORT_MANAGER_TERMINAL_SESSION_ID:-}" > "\${PORT_MANAGER_TERMINAL_ATTACHMENT_DIR}/\${__pm_signal_key}.tsv" 2>/dev/null || true
  unset __pm_signal_network __pm_signal_tty __pm_signal_pid __pm_signal_pgid __pm_signal_identity __pm_signal_key
}

__port_manager_route_table_generation() {
  [ -n "\${1:-}" ] && [ -r "$1" ] || return 1
  sed -n 's/.*"sequence"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$1" 2>/dev/null | head -n 1
}

__port_manager_route_table_has_compose_route() {
  [ -n "\${1:-}" ] && [ -r "$1" ] || return 1
  grep -Eq '"source"[[:space:]]*:[[:space:]]*"compose"' "$1" 2>/dev/null
}

__port_manager_wait_for_compose_route_refresh() {
  [ -n "\${PORT_MANAGER_COMPOSE_REFRESH_WAIT_MS+x}" ] || return 0
  __pm_wait_file="\${PORT_MANAGER_ROUTES_FILE:-}"
  [ -n "\${__pm_wait_file}" ] || { unset __pm_wait_file; return 0; }
  __pm_wait_previous="\${1:-}"
  __pm_wait_ms="\${PORT_MANAGER_COMPOSE_REFRESH_WAIT_MS:-3000}"
  case "\${__pm_wait_ms}" in ''|*[!0-9]*) __pm_wait_ms=3000 ;; esac
  [ "\${__pm_wait_ms}" -gt 0 ] 2>/dev/null || { unset __pm_wait_file __pm_wait_previous __pm_wait_ms; return 0; }
  [ "\${__pm_wait_ms}" -le 60000 ] 2>/dev/null || __pm_wait_ms=60000
  __pm_wait_limit=$(((__pm_wait_ms + 99) / 100))
  __pm_wait_count=0

  while [ "\${__pm_wait_count}" -lt "\${__pm_wait_limit}" ]; do
    __pm_wait_current="$(__port_manager_route_table_generation "\${__pm_wait_file}" 2>/dev/null || true)"
    if { [ -z "\${__pm_wait_previous}" ] || [ "\${__pm_wait_current}" != "\${__pm_wait_previous}" ]; } &&
      __port_manager_route_table_has_compose_route "\${__pm_wait_file}"; then
      unset __pm_wait_file __pm_wait_previous __pm_wait_ms __pm_wait_limit __pm_wait_count __pm_wait_current
      return 0
    fi
    __pm_wait_count=$((__pm_wait_count + 1))
    sleep 0.1 2>/dev/null || sleep 1
  done

  unset __pm_wait_file __pm_wait_previous __pm_wait_ms __pm_wait_limit __pm_wait_count __pm_wait_current
  return 0
}

__port_manager_compose_command_may_change_endpoints() {
  __pm_standalone="$1"
  shift
  __pm_seen_compose="\${__pm_standalone}"
  __pm_skip_next=0

  for __pm_arg in "$@"; do
    if [ "\${__pm_skip_next}" = "1" ]; then
      __pm_skip_next=0
      continue
    fi

    if [ "\${__pm_seen_compose}" = "0" ]; then
      if [ "\${__pm_arg}" = "compose" ]; then
        __pm_seen_compose=1
      fi
      continue
    fi

    case "\${__pm_arg}" in
      -f|--file|-p|--project-name|--profile|--env-file|--project-directory|--parallel|--progress|--ansi)
        __pm_skip_next=1
        continue
        ;;
      -f?*|--file=*|-p?*|--project-name=*|--profile=*|--env-file=*|--project-directory=*|--parallel=*|--progress=*|--ansi=*)
        continue
        ;;
      --compatibility|--dry-run|--verbose|--help|-h|--all-resources)
        continue
        ;;
      -*)
        continue
        ;;
      up|start|restart|create|run|down|stop|rm|kill)
        unset __pm_standalone __pm_seen_compose __pm_skip_next __pm_arg
        return 0
        ;;
      *)
        unset __pm_standalone __pm_seen_compose __pm_skip_next __pm_arg
        return 1
        ;;
    esac
  done

  unset __pm_standalone __pm_seen_compose __pm_skip_next __pm_arg
  return 1
}

__port_manager_compose_should_detach_up() {
  __pm_standalone="$1"
  shift
  __pm_seen_compose="\${__pm_standalone}"
  __pm_skip_next=0
  __pm_seen_up=0

  for __pm_arg in "$@"; do
    if [ "\${__pm_skip_next}" = "1" ]; then
      __pm_skip_next=0
      continue
    fi

    if [ "\${__pm_seen_compose}" = "0" ]; then
      if [ "\${__pm_arg}" = "compose" ]; then
        __pm_seen_compose=1
      fi
      continue
    fi

    if [ "\${__pm_seen_up}" = "0" ]; then
      case "\${__pm_arg}" in
        -f|--file|-p|--project-name|--profile|--env-file|--project-directory|--parallel|--progress|--ansi)
          __pm_skip_next=1
          continue
          ;;
        -f?*|--file=*|-p?*|--project-name=*|--profile=*|--env-file=*|--project-directory=*|--parallel=*|--progress=*|--ansi=*)
          continue
          ;;
        --compatibility|--dry-run|--verbose|--help|-h|--all-resources)
          continue
          ;;
        -*)
          continue
          ;;
        up)
          __pm_seen_up=1
          continue
          ;;
        *)
          return 1
          ;;
      esac
    fi

    case "\${__pm_arg}" in
      -d|--detach|--wait|--abort-on-container-exit|--abort-on-container-failure|--exit-code-from|--attach|--attach-dependencies|--menu)
        return 1
        ;;
      --detach=*|--wait=*|--abort-on-container-exit=*|--abort-on-container-failure=*|--exit-code-from=*|--attach=*|--attach-dependencies=*|--menu=*)
        return 1
        ;;
    esac
  done

  [ "\${__pm_seen_up}" = "1" ]
}

__port_manager_runtime_command_may_reference_container() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"

  case "\${__pm_first_command}" in
    ps)
      return 0
      ;;
    attach|commit|cp|diff|exec|export|inspect|kill|logs|pause|port|rename|restart|rm|start|stats|stop|top|unpause|update|wait)
      return 0
      ;;
    container)
      case "$(__port_manager_runtime_container_subcommand "$@")" in
        ls|list|ps)
          return 0
          ;;
        attach|commit|cp|diff|exec|export|inspect|kill|logs|pause|port|rename|restart|rm|start|stats|stop|top|unpause|update|wait)
          return 0
          ;;
      esac
      ;;
  esac

  return 1
}

__port_manager_runtime_command_uses_container_name_filters() {
  __pm_first_command="$(__port_manager_runtime_first_command "$@")"

  case "\${__pm_first_command}" in
    ps)
      return 0
      ;;
    container)
      case "$(__port_manager_runtime_container_subcommand "$@")" in
        ls|list|ps)
          return 0
          ;;
      esac
      ;;
  esac

  return 1
}

__port_manager_rewrite_container_name_filter() {
  __pm_runtime="$1"
  __pm_filter="$2"
  shift 2

  case "\${__pm_filter}" in
    name=*)
      __pm_filter_token="\${__pm_filter#name=}"
      ;;
    *)
      return 1
      ;;
  esac

  __pm_filter_prefix=""
  __pm_filter_suffix=""
  if [ "\${__pm_filter_token#\\^/}" != "\${__pm_filter_token}" ]; then
    __pm_filter_prefix="^/"
    __pm_filter_token="\${__pm_filter_token#\\^/}"
  elif [ "\${__pm_filter_token#\\^}" != "\${__pm_filter_token}" ]; then
    __pm_filter_prefix="^"
    __pm_filter_token="\${__pm_filter_token#\\^}"
  elif [ "\${__pm_filter_token#/}" != "\${__pm_filter_token}" ]; then
    __pm_filter_prefix="/"
    __pm_filter_token="\${__pm_filter_token#/}"
  fi
  case "\${__pm_filter_token}" in
    *'$')
      __pm_filter_suffix="$"
      __pm_filter_token="\${__pm_filter_token%$}"
      ;;
  esac

  __pm_filter_mapped="$(__port_manager_container_target_for_runtime "\${__pm_runtime}" "\${__pm_filter_token}" "$@")"
  if [ -z "\${__pm_filter_mapped}" ]; then
    return 1
  fi

  printf 'name=%s%s%s\\n' "\${__pm_filter_prefix}" "\${__pm_filter_mapped}" "\${__pm_filter_suffix}"
  return 0
}

__port_manager_run_runtime_with_container_routing() {
  __pm_runtime="$1"
  shift
  __pm_args=""
  __pm_filter_next=0
  __pm_rewrite_name_filters=0

  if __port_manager_runtime_command_uses_container_name_filters "$@"; then
    __pm_rewrite_name_filters=1
  fi

  for __pm_arg in "$@"; do
    if [ "\${__pm_filter_next}" = "1" ]; then
      __pm_filter_next=0
      __pm_mapped="$(__port_manager_rewrite_container_name_filter "\${__pm_runtime}" "\${__pm_arg}" "$@")"
      if [ -n "\${__pm_mapped}" ]; then
        __pm_arg="\${__pm_mapped}"
      fi
      __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
      continue
    fi

    if [ "\${__pm_rewrite_name_filters}" = "1" ]; then
      case "\${__pm_arg}" in
        --filter|-f|-*f)
          __pm_filter_next=1
          __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
          continue
          ;;
        --filter=name=*)
          __pm_filter_value="name=\${__pm_arg#--filter=name=}"
          __pm_mapped="$(__port_manager_rewrite_container_name_filter "\${__pm_runtime}" "\${__pm_filter_value}" "$@")"
          if [ -n "\${__pm_mapped}" ]; then
            __pm_arg="--filter=\${__pm_mapped}"
          fi
          ;;
        -f=name=*)
          __pm_filter_value="name=\${__pm_arg#-f=name=}"
          __pm_mapped="$(__port_manager_rewrite_container_name_filter "\${__pm_runtime}" "\${__pm_filter_value}" "$@")"
          if [ -n "\${__pm_mapped}" ]; then
            __pm_arg="-f=\${__pm_mapped}"
          fi
          ;;
        *)
          __pm_mapped="$(__port_manager_container_target_for_runtime "\${__pm_runtime}" "\${__pm_arg}" "$@")"
          if [ -n "\${__pm_mapped}" ]; then
            __pm_arg="\${__pm_mapped}"
          fi
          ;;
      esac
    else
      __pm_mapped="$(__port_manager_container_target_for_runtime "\${__pm_runtime}" "\${__pm_arg}" "$@")"
      if [ -n "\${__pm_mapped}" ]; then
        __pm_arg="\${__pm_mapped}"
      fi
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
    __pm_active_network="$(__port_manager_network_id 2>/dev/null || true)"
    if [ -n "\${__pm_active_network}" ]; then
      printf 'Port Manager compose routing unavailable for attached network %s; refusing to run host Compose command.\\n' "\${__pm_active_network}" >&2
      unset __pm_active_network
      return 127
    fi
    unset __pm_active_network
    command "\${__pm_command}" "$@"
    return $?
  fi

  __pm_tab="$(printf '\\t')"
  __pm_attached_project="\${__pm_route%%\${__pm_tab}*}"
  __pm_route_rest="\${__pm_route#*\${__pm_tab}}"
  __pm_original_project="\${__pm_route_rest%%\${__pm_tab}*}"
  if [ "\${__pm_route_rest}" = "\${__pm_original_project}" ]; then
    __pm_override_file=""
  else
    __pm_override_file="\${__pm_route_rest#*\${__pm_tab}}"
  fi
  __pm_args=""
  __pm_rewrite_next=0
  __pm_detach_up=0
  __pm_detach_inserted=0
  __pm_detach_seen_compose="\${__pm_standalone_compose}"
  __pm_detach_skip_next=0
  __pm_detach_waiting_subcommand=1
  __pm_override_enabled=0
  __pm_override_inserted=0
  __pm_override_seen_compose="\${__pm_standalone_compose}"
  __pm_override_skip_next=0
  __pm_override_waiting_subcommand=1
  if [ -n "\${__pm_override_file}" ] && [ ! -r "\${__pm_override_file}" ]; then
    printf 'Port Manager compose routing unavailable: generated override file is missing or unreadable: %s\\n' "\${__pm_override_file}" >&2
    printf '%s\\n' 'Refresh VS Code Port Manager or run Port Manager: Fix Stale Routing before running docker compose.' >&2
    return 1
  fi
  if [ -n "\${__pm_override_file}" ]; then
    if ! __port_manager_compose_args_reference_file "\${__pm_override_file}" "$@"; then
      __pm_override_enabled=1
    fi
  fi
  if __port_manager_compose_should_detach_up "\${__pm_standalone_compose}" "$@"; then
    __pm_detach_up=1
  fi
  __pm_route_generation_before=""
  if [ "\${__pm_detach_up}" = "1" ]; then
    __pm_route_generation_before="$(__port_manager_route_table_generation "\${PORT_MANAGER_ROUTES_FILE:-}" 2>/dev/null || true)"
  fi

  for __pm_arg in "$@"; do
    __pm_original_arg="\${__pm_arg}"
    __pm_insert_detach_after_arg=0
    if [ "\${__pm_detach_up}" = "1" ] && [ "\${__pm_detach_inserted}" = "0" ]; then
      if [ "\${__pm_detach_skip_next}" = "1" ]; then
        __pm_detach_skip_next=0
      elif [ "\${__pm_detach_seen_compose}" = "0" ]; then
        if [ "\${__pm_original_arg}" = "compose" ]; then
          __pm_detach_seen_compose=1
        fi
      elif [ "\${__pm_detach_waiting_subcommand}" = "1" ]; then
        case "\${__pm_original_arg}" in
          -f|--file|-p|--project-name|--profile|--env-file|--project-directory|--parallel|--progress|--ansi)
            __pm_detach_skip_next=1
            ;;
          -f?*|--file=*|-p?*|--project-name=*|--profile=*|--env-file=*|--project-directory=*|--parallel=*|--progress=*|--ansi=*)
            ;;
          --compatibility|--dry-run|--verbose|--help|-h|--all-resources)
            ;;
          -*)
            ;;
          up)
            __pm_insert_detach_after_arg=1
            __pm_detach_inserted=1
            __pm_detach_waiting_subcommand=0
            ;;
          *)
            __pm_detach_waiting_subcommand=0
            ;;
        esac
      fi
    fi

    if [ "\${__pm_override_enabled}" = "1" ] && [ "\${__pm_override_inserted}" = "0" ]; then
      if [ "\${__pm_override_skip_next}" = "1" ]; then
        __pm_override_skip_next=0
      elif [ "\${__pm_override_seen_compose}" = "0" ]; then
        if [ "\${__pm_original_arg}" = "compose" ]; then
          __pm_override_seen_compose=1
        fi
      elif [ "\${__pm_override_waiting_subcommand}" = "1" ]; then
        case "\${__pm_original_arg}" in
          -f|--file|-p|--project-name|--profile|--env-file|--project-directory|--parallel|--progress|--ansi)
            __pm_override_skip_next=1
            ;;
          -f?*|--file=*|-p?*|--project-name=*|--profile=*|--env-file=*|--project-directory=*|--parallel=*|--progress=*|--ansi=*)
            ;;
          --compatibility|--dry-run|--verbose|--help|-h|--all-resources)
            ;;
          -*)
            ;;
          *)
            __pm_args="\${__pm_args} -f $(__port_manager_shell_quote "\${__pm_override_file}")"
            __pm_override_inserted=1
            __pm_override_waiting_subcommand=0
            ;;
        esac
      fi
    fi

    if [ "\${__pm_rewrite_next}" = "1" ]; then
      __pm_arg="\${__pm_attached_project}"
      __pm_rewrite_next=0
      __pm_args="\${__pm_args} $(__port_manager_shell_quote "\${__pm_arg}")"
      if [ "\${__pm_insert_detach_after_arg}" = "1" ]; then
        __pm_args="\${__pm_args} --detach"
      fi
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
    if [ "\${__pm_insert_detach_after_arg}" = "1" ]; then
      __pm_args="\${__pm_args} --detach"
    fi
  done
  if [ "\${__pm_detach_up}" = "1" ] && [ "\${__pm_detach_inserted}" = "0" ]; then
    __pm_args="\${__pm_args} --detach"
  fi

  (COMPOSE_PROJECT_NAME="\${__pm_attached_project}"; export COMPOSE_PROJECT_NAME; eval "command \${__pm_command}\${__pm_args}")
  __pm_status=$?
  if [ "\${__pm_status}" = "0" ] && __port_manager_compose_command_may_change_endpoints "\${__pm_standalone_compose}" "$@"; then
    __port_manager_signal_terminal_attachment_changed
    if [ "\${__pm_detach_up}" = "1" ]; then
      __port_manager_wait_for_compose_route_refresh "\${__pm_route_generation_before}"
    fi
  fi
  unset __pm_route_generation_before
  return "\${__pm_status}"
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
}

__port_manager_define_absolute_runtime_function() {
  __pm_absolute_runtime_path="$1"
  __pm_runtime_function="$2"
  case "\${__pm_absolute_runtime_path}" in
    /*)
      eval "\${__pm_absolute_runtime_path}() { \${__pm_runtime_function} \\"\\$@\\"; }" 2>/dev/null || true
      ;;
  esac
}

if [ -n "\${ZSH_VERSION:-}" ] || { [ -n "\${BASH_VERSION:-}" ] && [ -z "\${POSIXLY_CORRECT:-}" ]; }; then
  eval 'docker-compose() { __port_manager_run_standalone_compose_with_routing docker docker-compose "$@"; }'
  eval 'podman-compose() { __port_manager_run_standalone_compose_with_routing podman podman-compose "$@"; }'
  __port_manager_define_absolute_runtime_function /usr/local/bin/docker docker
  __port_manager_define_absolute_runtime_function /opt/homebrew/bin/docker docker
  __port_manager_define_absolute_runtime_function /usr/bin/docker docker
  __port_manager_define_absolute_runtime_function /bin/docker docker
  __port_manager_define_absolute_runtime_function /Applications/Docker.app/Contents/Resources/bin/docker docker
  __port_manager_define_absolute_runtime_function /usr/local/bin/podman podman
  __port_manager_define_absolute_runtime_function /opt/homebrew/bin/podman podman
  __port_manager_define_absolute_runtime_function /usr/bin/podman podman
  __port_manager_define_absolute_runtime_function /bin/podman podman
  __port_manager_define_absolute_runtime_function /usr/local/bin/docker-compose docker-compose
  __port_manager_define_absolute_runtime_function /opt/homebrew/bin/docker-compose docker-compose
  __port_manager_define_absolute_runtime_function /usr/bin/docker-compose docker-compose
  __port_manager_define_absolute_runtime_function /bin/docker-compose docker-compose
  __port_manager_define_absolute_runtime_function /Applications/Docker.app/Contents/Resources/bin/docker-compose docker-compose
  __port_manager_define_absolute_runtime_function /usr/local/bin/podman-compose podman-compose
  __port_manager_define_absolute_runtime_function /opt/homebrew/bin/podman-compose podman-compose
  __port_manager_define_absolute_runtime_function /usr/bin/podman-compose podman-compose
  __port_manager_define_absolute_runtime_function /bin/podman-compose podman-compose
fi
`;
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

function isGeneratedComposeRoutingOverrideFile(composeFile: string): boolean {
  return composeFile.trim().endsWith(".ports.override.yaml");
}

function readGeneratedOverrideContainerNameState(composeFiles: readonly string[]): {
  readonly names: ReadonlyMap<string, string | undefined>;
} {
  const names = new Map<string, string | undefined>();

  for (const composeFile of composeFiles) {
    if (!isGeneratedComposeRoutingOverrideFile(composeFile)) {
      continue;
    }

    const text = readTextFile(composeFile);
    if (text === undefined) {
      continue;
    }

    for (const [serviceName, containerName] of parseComposeServiceContainerNames(text)) {
      names.set(serviceName, containerName);
    }
  }

  return { names };
}

function readSourceComposeContainerNames(composeFiles: readonly string[]): ReadonlyMap<string, string> {
  const names = new Map<string, string>();

  for (const composeFile of composeFiles) {
    if (isGeneratedComposeRoutingOverrideFile(composeFile)) {
      continue;
    }

    const text = readTextFile(composeFile);
    if (text === undefined) {
      continue;
    }

    for (const [serviceName, containerName] of parseComposeServiceContainerNames(text)) {
      if (containerName !== undefined) {
        names.set(serviceName, containerName);
      }
    }
  }

  return names;
}

function readTextFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function parseComposeServiceContainerNames(text: string): ReadonlyMap<string, string | undefined> {
  const names = new Map<string, string | undefined>();
  let inServices = false;
  let serviceIndent: number | undefined;
  let currentService: string | undefined;

  for (const rawLine of text.split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(rawLine)) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const trimmed = rawLine.trim();
    if (indent === 0) {
      inServices = /^services\s*:\s*(?:#.*)?$/.test(trimmed);
      serviceIndent = undefined;
      currentService = undefined;
      continue;
    }
    if (!inServices) {
      continue;
    }

    const separatorIndex = rawLine.indexOf(":", indent);
    if (separatorIndex < 0) {
      continue;
    }

    if (serviceIndent === undefined) {
      serviceIndent = indent;
    }
    if (indent === serviceIndent) {
      currentService = parseYamlMapKey(rawLine.slice(indent, separatorIndex));
      continue;
    }
    if (currentService === undefined || indent <= serviceIndent) {
      continue;
    }

    const key = parseYamlMapKey(rawLine.slice(indent, separatorIndex));
    if (key !== "container_name") {
      continue;
    }

    names.set(currentService, parseYamlScalarString(rawLine.slice(separatorIndex + 1)));
  }

  return names;
}

function parseYamlMapKey(value: string): string | undefined {
  return parseYamlScalarString(value);
}

function parseYamlScalarString(value: string): string | undefined {
  const scalar = stripYamlInlineComment(value).trim();
  if (scalar.length === 0 || scalar === "~" || /^null$/i.test(scalar)) {
    return undefined;
  }

  const quote = scalar[0];
  if ((quote === "'" || quote === "\"") && scalar.endsWith(quote)) {
    return scalar.slice(1, -1);
  }

  if (/^!reset(?:\s|$)/u.test(scalar)) {
    return undefined;
  }
  const tagMatch = /^![^\s]+(?:\s+(.+))?$/u.exec(scalar);
  if (tagMatch !== null) {
    const taggedValue = tagMatch[1]?.trim();
    return taggedValue === undefined || taggedValue.length === 0 ? undefined : parseYamlScalarString(taggedValue);
  }

  return scalar;
}

function stripYamlInlineComment(value: string): string {
  let quote: string | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if ((character === "'" || character === "\"") && (index === 0 || value[index - 1] !== "\\")) {
      quote = quote === character ? undefined : quote ?? character;
      continue;
    }

    if (character === "#" && quote === undefined && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
      return value.slice(0, index);
    }
  }

  return value;
}

function inferOriginalContainerName(attachedContainerName: string, attachedProjectName: string): string | undefined {
  const containerName = stripContainerNamePrefix(attachedContainerName);
  for (const separator of ["-", "_"]) {
    const suffix = `${separator}${attachedProjectName}`;
    if (containerName.endsWith(suffix) && containerName.length > suffix.length) {
      return containerName.slice(0, -suffix.length);
    }
  }

  return undefined;
}

function defaultComposeContainerName(attachedProjectName: string, serviceName: string): string {
  return `${attachedProjectName}-${serviceName}-1`;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function trimTrailingSlashes(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 1 ? trimmed.replace(/\/+$/g, "") : trimmed;
}

function stripContainerNamePrefix(value: string): string {
  return value.startsWith("/") ? value.slice(1) : value;
}

function buildContainerRoutingRows(row: ComposeProjectRoutingRow): readonly string[] {
  const lines: string[] = [];
  const seen = new Set<string>();

  for (const mapping of row.containerMappings ?? []) {
    appendContainerRoutingRow(lines, seen, row, {
      originalContainerId: stripContainerNamePrefix(mapping.originalContainerId),
      originalContainerName: stripContainerNamePrefix(mapping.originalContainerName),
      attachedContainerId: stripContainerNamePrefix(mapping.attachedContainerId),
      attachedContainerName: stripContainerNamePrefix(mapping.attachedContainerName),
      serviceName: mapping.serviceName,
    });

    for (const alias of buildContainerNameAliases(row, mapping)) {
      appendContainerRoutingRow(lines, seen, row, {
        // Alias rows should only match by exact name. Keep id fields out of Docker's
        // short-hash prefix matching so names like "postgres-1" do not become broad prefixes.
        originalContainerId: `__portmanager_alias__:${alias}`,
        originalContainerName: alias,
        attachedContainerId:
          mapping.attachedContainerName.trim().length > 0
            ? `__portmanager_alias_target__:${alias}`
            : stripContainerNamePrefix(mapping.attachedContainerId),
        attachedContainerName: stripContainerNamePrefix(mapping.attachedContainerName),
        serviceName: "",
      });
    }
  }

  return lines;
}

function appendContainerRoutingRow(
  lines: string[],
  seen: Set<string>,
  row: ComposeProjectRoutingRow,
  fields: {
    readonly originalContainerId: string;
    readonly originalContainerName: string;
    readonly attachedContainerId: string;
    readonly attachedContainerName: string;
    readonly serviceName: string;
  },
): void {
  const line = [
    "container",
    sanitizeField(row.networkId),
    row.runtime,
    sanitizeField(trimTrailingSlashes(row.workingDirectory)),
    sanitizeField(fields.originalContainerId),
    sanitizeField(fields.originalContainerName),
    sanitizeField(fields.attachedContainerId),
    sanitizeField(fields.attachedContainerName),
    sanitizeField(fields.serviceName),
  ].join("\t");

  if (seen.has(line)) {
    return;
  }

  seen.add(line);
  lines.push(line);
}

function buildContainerNameAliases(
  row: ComposeProjectRoutingRow,
  mapping: ComposeContainerRoutingMapping,
): readonly string[] {
  const aliases = new Set<string>();
  const exactNames = new Set(
    [
      stripContainerNamePrefix(mapping.originalContainerId),
      stripContainerNamePrefix(mapping.originalContainerName),
      stripContainerNamePrefix(mapping.attachedContainerId),
      stripContainerNamePrefix(mapping.attachedContainerName),
      mapping.serviceName,
    ].filter((value) => value.length > 0),
  );
  const projectNames = [row.originalProjectName, row.attachedProjectName].flatMap((projectName) =>
    buildProjectNameVariants(projectName),
  );
  const containerNames = [
    stripContainerNamePrefix(mapping.originalContainerName),
    stripContainerNamePrefix(mapping.attachedContainerName),
  ];

  for (const containerName of containerNames) {
    const unindexedName = stripComposeReplicaIndex(containerName);
    if (unindexedName !== undefined && unindexedName.length > 0 && !exactNames.has(unindexedName)) {
      aliases.add(unindexedName);
    }

    for (const projectName of projectNames) {
      const alias = stripComposeProjectPrefix(containerName, projectName);
      if (alias !== undefined && alias.length > 0 && !exactNames.has(alias)) {
        aliases.add(alias);
      }
      const unindexedAlias = alias === undefined ? undefined : stripComposeReplicaIndex(alias);
      if (unindexedAlias !== undefined && unindexedAlias.length > 0 && !exactNames.has(unindexedAlias)) {
        aliases.add(unindexedAlias);
      }
    }
  }

  return [...aliases];
}

function buildProjectNameVariants(projectName: string | undefined): readonly string[] {
  const trimmed = projectName?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return [];
  }

  const sanitized = trimmed
    .replace(/^\/+/, "")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .replace(/[_.-]+$/g, "");

  return [...new Set([trimmed, sanitized].filter((value) => value.length > 0))];
}

function stripComposeReplicaIndex(containerName: string): string | undefined {
  const stripped = containerName.replace(/[-_]\d+$/u, "");
  return stripped === containerName ? undefined : stripped;
}

function stripComposeProjectPrefix(containerName: string, projectName: string): string | undefined {
  for (const separator of ["-", "_"]) {
    const prefix = `${projectName}${separator}`;
    if (containerName.startsWith(prefix)) {
      return containerName.slice(prefix.length);
    }
  }

  return undefined;
}
