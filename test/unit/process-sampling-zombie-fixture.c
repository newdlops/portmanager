/* Keep only our exited child unreaped until the test closes stdin. */
#include <stdio.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

int main(void) {
  pid_t child = fork();
  if (child < 0) return 1;
  if (child == 0) _exit(0);
  printf("%ld\n", (long)child);
  fflush(stdout);
  (void)getchar();
  return waitpid(child, NULL, 0) == child ? 0 : 2;
}
