#ifndef PM_NETWORK_NAMESPACE_H
#define PM_NETWORK_NAMESPACE_H

#include <stddef.h>
#include <string.h>

/* Matches network-identity.ts. Reject oversize ids rather than truncating two
 * identities into one namespace. Display names have no storage authority. */
#define PM_NETWORK_NAMESPACE_MAX_ID_BYTES 124
#define PM_NETWORK_NAMESPACE_KEY_SIZE (3 + 2 * PM_NETWORK_NAMESPACE_MAX_ID_BYTES + 1)

static int pm_network_namespace_key(const char *network_id, char *key, size_t size) {
  static const char hex[] = "0123456789abcdef";
  size_t length;
  if (network_id == NULL) return -1;
  length = strnlen(network_id, PM_NETWORK_NAMESPACE_MAX_ID_BYTES + 1);
  if (length == 0 || length > PM_NETWORK_NAMESPACE_MAX_ID_BYTES || size < 4 + 2 * length) return -1;
  memcpy(key, "id-", 3);
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = (unsigned char)network_id[index];
    key[3 + index * 2] = hex[byte >> 4];
    key[4 + index * 2] = hex[byte & 15];
  }
  key[3 + length * 2] = '\0';
  return 0;
}

#endif
