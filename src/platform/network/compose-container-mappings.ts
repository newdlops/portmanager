import type { ComposeContainerMutationMapping } from "../../shared/types";

/**
 * Container mapping aliases preserve tokens that used to name a compose
 * container, while routing them to the current hidden clone container.
 */
export const CONTAINER_ALIAS_SERVICE_PREFIX = "__portmanager_alias__:";

/** True when a mapping row exists only to rewrite stale container id/name tokens. */
export function isComposeContainerAliasMapping(mapping: ComposeContainerMutationMapping): boolean {
  return mapping.serviceName.length === 0 || mapping.serviceName.startsWith(CONTAINER_ALIAS_SERVICE_PREFIX);
}

/**
 * Carries previous compose container ids/names forward when a clone is copied
 * or recreated. The canonical rows describe the current original->attached
 * relationship; previous rows become aliases that route older Docker tokens to
 * the new attached container.
 */
export function mergeComposeContainerMappingLineage(
  previousMappings: readonly ComposeContainerMutationMapping[],
  canonicalMappings: readonly ComposeContainerMutationMapping[],
): readonly ComposeContainerMutationMapping[] {
  const canonicalRows = uniqueMappings(canonicalMappings.filter((mapping) => !isComposeContainerAliasMapping(mapping)));
  if (canonicalRows.length === 0) {
    return [];
  }

  const canonicalByService = new Map(canonicalRows.map((mapping) => [mapping.serviceName, mapping]));
  const previousServiceByAttachedId = new Map<string, string>();
  for (const mapping of previousMappings) {
    if (!isComposeContainerAliasMapping(mapping) && mapping.attachedContainerId.trim().length > 0) {
      previousServiceByAttachedId.set(mapping.attachedContainerId, mapping.serviceName);
    }
  }

  const aliases: ComposeContainerMutationMapping[] = [];
  const aliasKeys = new Set(canonicalRows.map(mappingIdentity));

  for (const previous of previousMappings) {
    const serviceName = resolveAliasTargetService(previous, previousServiceByAttachedId);
    const target = serviceName === undefined ? undefined : canonicalByService.get(serviceName);
    if (target === undefined) {
      continue;
    }

    pushComposeContainerAlias(aliases, aliasKeys, previous.originalContainerId, previous.originalContainerName, target);
    pushComposeContainerAlias(aliases, aliasKeys, previous.attachedContainerId, previous.attachedContainerName, target);
  }

  return [...canonicalRows, ...aliases];
}

function resolveAliasTargetService(
  mapping: ComposeContainerMutationMapping,
  previousServiceByAttachedId: ReadonlyMap<string, string>,
): string | undefined {
  if (!isComposeContainerAliasMapping(mapping)) {
    return mapping.serviceName;
  }

  if (mapping.serviceName.startsWith(CONTAINER_ALIAS_SERVICE_PREFIX)) {
    const serviceName = mapping.serviceName.slice(CONTAINER_ALIAS_SERVICE_PREFIX.length);
    return serviceName.length > 0 ? serviceName : undefined;
  }

  return previousServiceByAttachedId.get(mapping.attachedContainerId);
}

function pushComposeContainerAlias(
  aliases: ComposeContainerMutationMapping[],
  keys: Set<string>,
  sourceId: string,
  sourceName: string,
  target: ComposeContainerMutationMapping,
): void {
  const id = sourceId.trim();
  const name = sourceName.trim();
  if (id.length === 0 && name.length === 0) {
    return;
  }

  const sourceToken = id.length > 0 ? id : name;
  const sourceDisplayName = name.length === 0 || name === target.attachedContainerName ? sourceToken : name;
  if (sourceToken === target.attachedContainerId) {
    return;
  }
  if (
    sourceToken === target.originalContainerId &&
    (sourceDisplayName.length === 0 || sourceDisplayName === target.originalContainerName)
  ) {
    return;
  }

  const alias: ComposeContainerMutationMapping = {
    serviceName: `${CONTAINER_ALIAS_SERVICE_PREFIX}${target.serviceName}`,
    originalContainerId: sourceToken,
    originalContainerName: sourceDisplayName,
    attachedContainerId: target.attachedContainerId,
    attachedContainerName: target.attachedContainerName,
  };
  const key = mappingIdentity(alias);
  if (keys.has(key)) {
    return;
  }

  keys.add(key);
  aliases.push(alias);
}

function uniqueMappings(
  mappings: readonly ComposeContainerMutationMapping[],
): readonly ComposeContainerMutationMapping[] {
  const seen = new Set<string>();
  const result: ComposeContainerMutationMapping[] = [];

  for (const mapping of mappings) {
    const key = mappingIdentity(mapping);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(mapping);
  }

  return result;
}

function mappingIdentity(mapping: ComposeContainerMutationMapping): string {
  return [
    mapping.serviceName,
    mapping.originalContainerId,
    mapping.originalContainerName,
    mapping.attachedContainerId,
    mapping.attachedContainerName,
  ].join("\0");
}
