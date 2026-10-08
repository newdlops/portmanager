#ifndef PM_NETWORK_BROKER_PROTOCOL_H
#define PM_NETWORK_BROKER_PROTOCOL_H

#include <stdint.h>

/* Local, versioned binary frames keep untrusted input bounded. There is no
 * network id, PID, executable, filename, or management method on this wire. */
#define PM_NB_MAGIC 0x504d4e42U
#define PM_NB_VERSION 1
#define PM_NB_NONBLOCK 1U
#define PM_NB_CLOEXEC 2U
#define PM_NB_FD_ACK 0xa7U
#define PM_NB_ADDRESS_CAPACITY 128
/* Darwin XNU's UIPC_MAX_CMSG_FD is 512 (Linux accepts fewer). Receive a whole
 * kernel rights message so excess FDs can be closed instead of truncating. */
#define PM_NB_RIGHTS_CAPACITY 512
enum pm_nb_operation { PM_NB_SOCKET = 1, PM_NB_BIND, PM_NB_CONNECT, PM_NB_LISTEN, PM_NB_ACCEPT };

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t operation;
  uint32_t flags;
  int32_t domain;
  int32_t type;
  int32_t protocol;
  int32_t backlog;
  uint32_t address_length;
  unsigned char address[PM_NB_ADDRESS_CAPACITY];
} pm_nb_request;

typedef struct {
  uint32_t magic;
  uint16_t version;
  uint16_t operation;
  int32_t result;
  int32_t error;
  uint32_t address_length;
  unsigned char address[PM_NB_ADDRESS_CAPACITY];
} pm_nb_response;

_Static_assert(sizeof(pm_nb_request) == 160, "broker request layout must be stable");
_Static_assert(sizeof(pm_nb_response) == 148, "broker response layout must be stable");
#endif
