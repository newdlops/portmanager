/* Exercise the real hook's file boundary without loading it into another app. */
#include "../../native/hook/portmanager_hook.c"

int main(int argc, char **argv) {
  if (argc == 4 && strcmp(argv[1], "copy") == 0) {
    umask(0022);
    return pm_file_substitution_copy_file(argv[2], argv[3]) == 0 ? 0 : 1;
  }
  if (argc == 3 && strcmp(argv[1], "key") == 0) {
    char key[PM_NETWORK_NAMESPACE_KEY_SIZE];
    if (pm_network_namespace_key(argv[2], key, sizeof(key)) != 0) return 1;
    puts(key);
    return 0;
  }
  if (argc == 3 && strcmp(argv[1], "context") == 0) {
    pm_file_substitution_context context;
    if (pm_file_substitution_build_context(argv[2], &context) != 0) return 1;
    puts(context.prefix);
    return 0;
  }
  if (argc >= 4 && (strcmp(argv[1], "apply") == 0 || strcmp(argv[1], "read") == 0 || strcmp(argv[1], "write") == 0)) {
    setenv("PORT_MANAGER_HOOK_DISABLED", "0", 1);
    setenv("PORT_MANAGER_HOOK", "1", 1);
    setenv("PORT_MANAGER_NETWORK_ID", argv[2], 1);
    setenv("PORT_MANAGER_NETWORK_NAME", argv[3], 1);
    setenv("PORT_MANAGER_NETWORK_IS_GLOBAL", "0", 1);
    unsetenv("PORT_MANAGER_NETWORK_ENV_APPLIED");
    if (argc == 6 && strcmp(argv[1], "write") == 0) {
      pm_file_substitution_init();
      int fd = pm_substitute_open_hook(argv[4], O_WRONLY | O_CREAT | O_TRUNC, 0600);
      if (fd < 0) return 1;
      ssize_t count = write(fd, argv[5], strlen(argv[5]));
      close(fd);
      return count == (ssize_t)strlen(argv[5]) ? 0 : 1;
    }
    if (argc == 5 && strcmp(argv[1], "read") == 0) {
      pm_file_substitution_init();
      int fd = pm_substitute_open_hook(argv[4], O_RDONLY);
      if (fd < 0) return 1;
      char buffer[4096];
      ssize_t count;
      while ((count = read(fd, buffer, sizeof(buffer))) > 0) {
        if (write(STDOUT_FILENO, buffer, (size_t)count) != count) return 1;
      }
      close(fd);
      return count < 0 ? 1 : 0;
    }
    pm_apply_network_env_file();
    const char *value = getenv("PM_AUDIT_VALUE");
    if (value == NULL) return 1;
    puts(value);
    return 0;
  }
  return 2;
}
