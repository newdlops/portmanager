/* Include the real publisher with controlled syscall checkpoints. Only this
 * fixture's private directory is used; no app, terminal or signal target exists. */
#define _DARWIN_C_SOURCE
#include <unistd.h>
#include <sys/stdio.h>
int pm_publication_unlinkat(int, const char *, int);
int pm_publication_renameatx(int, const char *, int, const char *, unsigned int);
#define main pm_publication_original_main
#define unlinkat pm_publication_unlinkat
#define renameatx_np pm_publication_renameatx
#include "../../native/network-launcher/portmanager_network_launch.c"
#undef main
#undef unlinkat
#undef renameatx_np

static const char *pm_publication_gate;
static const char *pm_publication_leaf;
static int pm_publication_gated;

static void pm_publication_checkpoint(void) {
  if (pm_publication_gated) return;
  pm_publication_gated = 1;
  char entered[PATH_MAX], release[PATH_MAX];
  snprintf(entered, sizeof(entered), "%s/entered.js", pm_publication_gate);
  snprintf(release, sizeof(release), "%s/release.js", pm_publication_gate);
  int fd = open(entered, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) _exit(3);
  (void)write(fd, "entered\n", 8); close(fd);
  long long deadline = pm_nb_client_now() + 5000;
  while (access(release, F_OK) != 0) {
    if (pm_nb_client_now() >= deadline) _exit(4);
    usleep(1000);
  }
}
int pm_publication_unlinkat(int directory, const char *leaf, int flags) {
  /* Legacy publication has already exposed a two-link file here. */
  if (strncmp(leaf, ".ready-", 7) == 0 || strncmp(leaf, ".owner-", 7) == 0) pm_publication_checkpoint();
  int (*original)(int, const char *, int) = (int (*)(int, const char *, int))dlsym(RTLD_DEFAULT, "unlinkat");
  if (original == NULL) { errno = ENOSYS; return -1; }
  return original(directory, leaf, flags);
}
int pm_publication_renameatx(int from_directory, const char *from, int to_directory, const char *to, unsigned int flags) {
  /* Exclusive rename exposes nothing until the atomic move itself. */
  if (strcmp(to, pm_publication_leaf) == 0) pm_publication_checkpoint();
  int (*original)(int, const char *, int, const char *, unsigned int) =
    (int (*)(int, const char *, int, const char *, unsigned int))dlsym(RTLD_DEFAULT, "renameatx_np");
  if (original == NULL) { errno = ENOSYS; return -1; }
  return original(from_directory, from, to_directory, to, flags);
}
int main(int argc, char **argv) {
  if (argc != 4) return 2;
  pm_publication_gate = argv[3]; pm_publication_leaf = strrchr(argv[2], '/');
  if (pm_publication_leaf == NULL) return 2;
  pm_publication_leaf++;
  if (strcmp(argv[1], "ready") == 0) {
    pm_launch_options options; memset(&options, 0, sizeof(options));
    options.ready_path = argv[2]; options.network_id = "publication";
    pm_launch_readiness ready;
    if (pm_launch_publish_ready(&ready, &options, getpid(), pm_launch_birth(getpid())) != 0) return 1;
    close(ready.directory); return 0; // Leave the published record for the strict reader.
  }
  if (strcmp(argv[1], "receipt") == 0) {
    const char record[] = "{\"version\":1,\"cleaned\":true}\n";
    return pm_launch_record_publish(argv[2], record, sizeof(record) - 1, NULL) == 0 ? 0 : 1;
  }
  return 2;
}
