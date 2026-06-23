#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

/*
 * Injects one command into a PTY input queue.
 *
 * Writing to /dev/ttysNNN normally prints to the terminal display rather than
 * feeding the foreground shell. TIOCSTI targets the terminal input queue, which
 * lets non-standard terminal hosts be treated like regular OS terminal sessions
 * when the current user is allowed to control that TTY.
 */
int main(int argc, char **argv) {
  if (argc != 3) {
    fprintf(stderr, "usage: portmanager_tty_input /dev/tty command\n");
    return 2;
  }

  const char *tty_path = argv[1];
  const char *command = argv[2];

  if (strncmp(tty_path, "/dev/", 5) != 0) {
    fprintf(stderr, "refusing non-device tty path: %s\n", tty_path);
    return 2;
  }

  int fd = open(tty_path, O_RDWR | O_NOCTTY);
  if (fd < 0) {
    fprintf(stderr, "open %s failed: %s\n", tty_path, strerror(errno));
    return 3;
  }

  for (const char *cursor = command; *cursor != '\0'; cursor++) {
    char ch = *cursor;
    if (ioctl(fd, TIOCSTI, &ch) < 0) {
      fprintf(stderr, "TIOCSTI %s failed: %s\n", tty_path, strerror(errno));
      close(fd);
      return 4;
    }
  }

  char newline = '\n';
  if (ioctl(fd, TIOCSTI, &newline) < 0) {
    fprintf(stderr, "TIOCSTI newline %s failed: %s\n", tty_path, strerror(errno));
    close(fd);
    return 4;
  }

  close(fd);
  return 0;
}
