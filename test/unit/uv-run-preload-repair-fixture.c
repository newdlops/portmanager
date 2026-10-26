/* Stand-ins for a preload-dropping uv and the runtime it launches.
 *
 * Named `uv`/`uvx` and signed with the hardened runtime, dyld strips DYLD_* from
 * this process exactly like the official uv build. It records its argv
 * (NUL-separated) to $PM_FIXTURE_ARGS_FILE and then, like `uv run`, executes the
 * command — which starts at the inserted /bin/sh trampoline when the shim
 * rewrote the invocation. Under any other name it reports the preload, PATH and
 * argv it received, so the test sees what the real child would get. */
#include <libgen.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int record_arguments(int argc, char **argv) {
  const char *path = getenv("PM_FIXTURE_ARGS_FILE");
  FILE *file;

  if (path == NULL || path[0] == '\0') {
    return 0;
  }
  file = fopen(path, "wb");
  if (file == NULL) {
    return -1;
  }
  for (int index = 1; index < argc; index++) {
    fputs(argv[index], file);
    fputc('\0', file);
  }
  return fclose(file);
}

int main(int argc, char **argv) {
  const char *name = basename(argv[0]);

  if (strcmp(name, "uv") == 0 || strcmp(name, "uvx") == 0) {
    if (record_arguments(argc, argv) != 0) {
      perror("record arguments");
      return 70;
    }
    for (int index = 1; index < argc; index++) {
      if (strcmp(argv[index], "/bin/sh") == 0) {
        execv(argv[index], argv + index);
        perror("execv");
        return 127;
      }
    }
    return 0;
  }

  const char *preload = getenv("DYLD_INSERT_LIBRARIES");
  const char *path = getenv("PATH");
  printf("preload=%s\n", preload == NULL ? "" : preload);
  printf("path=%s\n", path == NULL ? "" : path);
  for (int index = 1; index < argc; index++) {
    printf("arg=%s\n", argv[index]);
  }
  return 0;
}
