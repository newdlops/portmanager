#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

/* Disposable malicious-process simulations. stdout/files are fixture protocols;
 * no product process, terminal or signal target is accepted as an argument. */
static unsigned long long process_birth(pid_t pid) {
  struct proc_bsdinfo info;
  return proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) == sizeof(info) ?
    (unsigned long long)info.pbi_start_tvsec * 1000000 + info.pbi_start_tvusec : 0;
}
static void tick(const char *path) {
  int fd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0600);
  if (fd >= 0) { (void)write(fd, "x", 1); close(fd); }
}
static void report(const char *path) {
  char temporary[2048];
  if (snprintf(temporary, sizeof(temporary), "%s.next", path) >= (int)sizeof(temporary)) _exit(2);
  int fd = open(temporary, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (fd < 0) _exit(2);
  char line[256]; int size = snprintf(line, sizeof(line), "{\"pid\":%ld,\"birth\":%llu,\"ppid\":%ld,\"sid\":%ld}\n",
    (long)getpid(), process_birth(getpid()), (long)getppid(), (long)getsid(0));
  if (write(fd, line, (size_t)size) != size) _exit(2);
  close(fd);
  if (rename(temporary, path) != 0) _exit(2);
}
static int generation_proof(void) {
  pid_t child = fork(); if (child == 0) { for (;;) pause(); }
  if (child < 0) return 2;
  mach_port_t task = MACH_PORT_NULL; audit_token_t token;
  mach_msg_type_number_t size = TASK_AUDIT_TOKEN_COUNT;
  int valid = task_name_for_pid(mach_task_self(), child, &task) == KERN_SUCCESS &&
    task_info(task, TASK_AUDIT_TOKEN, (task_info_t)&token, &size) == KERN_SUCCESS;
  if (task != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), task);
  int rejected = 0, stopped = 0;
  if (valid) {
    audit_token_t stale = token; stale.val[7] ^= 1;
    rejected = proc_signal_with_audittoken(&stale, SIGKILL) == ESRCH && kill(child, 0) == 0;
    if (rejected) stopped = proc_signal_with_audittoken(&token, SIGKILL) == 0;
  }
  /* Still-unreaped fork child is the only raw signal target in this fixture. */
  (void)kill(child, SIGKILL); int status; while (waitpid(child, &status, 0) < 0 && errno == EINTR) {}
  if (!valid || !rejected || !stopped) return 2;
  puts("generation-ok"); return 0;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "nested-entered") == 0) return 77;
  if (argc == 2 && strcmp(argv[1], "generation") == 0) return generation_proof();
  if (argc == 2 && strcmp(argv[1], "hold") == 0) { puts("holding"); fflush(stdout); sleep(30); return 0; }
  if (argc == 2 && strcmp(argv[1], "input") == 0) {
    char input[128]; ssize_t count = read(0, input, sizeof(input) - 1);
    if (count <= 0) return 2;
    input[count] = '\0'; printf("INPUT=%s", input); fflush(stdout); return strcmp(input, "clean\n") == 0 ? 0 : 2;
  }
  if (argc < 5 || strcmp(argv[1], "orphan") != 0) return 2;
  const char *report_path = argv[2], *ticks = argv[3], *mode = argv[4];
  pid_t intermediate = fork();
  if (intermediate == 0) {
    if (setsid() < 0) _exit(2);
    pid_t orphan = fork(); if (orphan < 0) _exit(2); if (orphan > 0) _exit(0);
    if (setsid() < 0) _exit(2);
    signal(SIGTERM, SIG_IGN);
    setenv("PORT_MANAGER_NETWORK_ID", "network-b", 1); setenv("PORT_MANAGER_HOOK_DISABLED", "1", 1);
    if (strcmp(mode, "nested") == 0) {
      const char *policies[] = { "(version 1)(allow default)",
        "(version 1)(allow default)(deny file-read-data (regex #\"/[.]portmanager/\"))" };
      for (size_t index = 0; index < sizeof(policies) / sizeof(policies[0]); index++) {
        pid_t changing = fork();
        if (changing == 0) { execl("/usr/bin/sandbox-exec", "sandbox-exec", "-p", policies[index], argv[0], "nested-entered", (char *)NULL); _exit(2); }
        if (changing < 0) _exit(2);
        int changed; while (waitpid(changing, &changed, 0) < 0 && errno == EINTR) {}
        if (!WIFEXITED(changed) || WEXITSTATUS(changed) == 77) _exit(2);
      }
    }
    if (strcmp(mode, "tty") != 0) { close(0); close(1); close(2); }
    for (int attempt = 0; getppid() != 1 && attempt < 1000; attempt++) usleep(1000);
    if (getppid() != 1) _exit(2);
    report(report_path);
    if (strcmp(mode, "sip") == 0 && argc == 6) {
      char command[2048];
      int bytes = snprintf(command, sizeof(command), "printf sip-ready > '%s'; exec /bin/sleep 25", argv[5]);
      if (bytes < 0 || (size_t)bytes >= sizeof(command)) _exit(2);
      execl("/bin/sh", "sh", "-c", command, (char *)NULL); _exit(2);
    }
    unsigned long long started = (unsigned long long)time(NULL);
    for (;;) {
      tick(ticks);
      if ((unsigned long long)time(NULL) - started > 25) _exit(0);
      if (strcmp(mode, "churn") == 0) {
        pid_t grandchild = fork();
        if (grandchild == 0) { for (int turn = 0; turn < 1000; turn++) { tick(ticks); usleep(20000); } _exit(0); }
      }
      if (strcmp(mode, "tty") == 0 && argc == 7 && access(argv[5], F_OK) == 0) {
        int terminal = open(argv[6], O_RDWR | O_NOCTTY | O_NONBLOCK);
        if (terminal >= 0) {
          char character = 'e'; (void)ioctl(terminal, TIOCSTI, &character);
          (void)write(terminal, "ESCAPED_TTY\n", 12); close(terminal);
        }
      }
      usleep(20000);
    }
  }
  if (intermediate < 0) return 2;
  int status; while (waitpid(intermediate, &status, 0) < 0 && errno == EINTR) {}
  for (int attempt = 0; access(report_path, F_OK) != 0 && attempt < 2000; attempt++) usleep(1000);
  if (access(report_path, F_OK) != 0) return 2;
  if (strcmp(mode, "sip") == 0 && argc == 6) {
    for (int attempt = 0; access(argv[5], F_OK) != 0 && attempt < 2000; attempt++) usleep(1000);
    if (access(argv[5], F_OK) != 0) return 2;
    /* The sentinel is written by the protected system shell after exec. */
  }
  if (strcmp(mode, "linger") == 0) sleep(30);
  /* Root exits naturally while the escaped, signal-ignoring worker is alive. */
  return 0;
}
