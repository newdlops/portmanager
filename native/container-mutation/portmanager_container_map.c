#define _POSIX_C_SOURCE 200809L

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/*
 * Looks up one Docker/Podman container token in Port Manager's TSV routing map.
 *
 * Compose mutation policy stays in TypeScript. This helper only performs the
 * low-level, deterministic token transform used by shell wrappers:
 * original container id/name -> attached clone container name when available.
 */

static char *pm_trim_line(char *line) {
  size_t length = strlen(line);

  while (length > 0 && (line[length - 1] == '\n' || line[length - 1] == '\r')) {
    line[length - 1] = '\0';
    length--;
  }

  return line;
}

static int pm_split_tsv(char *line, char **fields, int max_fields) {
  int count = 0;
  char *cursor = line;

  while (count < max_fields) {
    fields[count++] = cursor;
    cursor = strchr(cursor, '\t');
    if (cursor == NULL) {
      break;
    }
    *cursor = '\0';
    cursor++;
  }

  return count;
}

static int pm_starts_with(const char *value, const char *prefix) {
  size_t prefix_length = strlen(prefix);

  return strncmp(value, prefix, prefix_length) == 0;
}

static int pm_token_matches_mapping(
  const char *token,
  const char *original_id,
  const char *original_name,
  const char *attached_id,
  const char *attached_name,
  const char *service_name
) {
  size_t token_length = strlen(token);

  if (strcmp(token, original_name) == 0 || strcmp(token, attached_name) == 0 || strcmp(token, service_name) == 0) {
    return 1;
  }

  /*
   * Docker accepts short hashes, and older persisted mappings may contain only
   * a short hash. Accept both token-prefix and row-prefix matches after four
   * chars, then require the final lookup to be unique.
   */
  if (
    token_length >= 4 &&
    (
      pm_starts_with(original_id, token) ||
      pm_starts_with(token, original_id) ||
      pm_starts_with(attached_id, token) ||
      pm_starts_with(token, attached_id)
    )
  ) {
    return 1;
  }

  return 0;
}

static const char *pm_target_container_name(const char *attached_id, const char *attached_name) {
  return attached_name != NULL && attached_name[0] != '\0' ? attached_name : attached_id;
}

static int pm_write_target(const char *target, const char *suffix) {
  if (printf("%s%s\n", target, suffix) < 0) {
    return 1;
  }

  return 0;
}

int main(int argc, char **argv) {
  const char *routing_file;
  const char *network_id;
  const char *runtime;
  char *token;
  char *suffix;
  char *token_suffix;
  FILE *file;
  char *line = NULL;
  size_t line_capacity = 0;
  ssize_t line_length;
  int matches = 0;
  char *target = NULL;

  if (argc != 5 || argv[1][0] == '\0' || argv[2][0] == '\0' || argv[3][0] == '\0' || argv[4][0] == '\0') {
    return 1;
  }

  routing_file = argv[1];
  network_id = argv[2];
  runtime = argv[3];
  token = strdup(argv[4]);
  if (token == NULL) {
    return 1;
  }

  suffix = strchr(token, ':');
  if (suffix != NULL) {
    token_suffix = strdup(suffix);
    *suffix = '\0';
  } else {
    token_suffix = strdup("");
  }

  if (token_suffix == NULL) {
    free(token);
    return 1;
  }

  if (token[0] == '\0') {
    free(token_suffix);
    free(token);
    return 1;
  }

  file = fopen(routing_file, "r");
  if (file == NULL) {
    free(token_suffix);
    free(token);
    return 1;
  }

  while ((line_length = getline(&line, &line_capacity, file)) >= 0) {
    char *fields[9];
    int field_count;

    (void)line_length;
    pm_trim_line(line);
    field_count = pm_split_tsv(line, fields, 9);

    if (field_count < 8) {
      continue;
    }

    if (
      strcmp(fields[0], "container") != 0 ||
      strcmp(fields[1], network_id) != 0 ||
      strcmp(fields[2], runtime) != 0
    ) {
      continue;
    }

    if (pm_token_matches_mapping(token, fields[4], fields[5], fields[6], fields[7], field_count >= 9 ? fields[8] : "")) {
      char *next_target = strdup(pm_target_container_name(fields[6], fields[7]));
      if (next_target == NULL) {
        free(target);
        free(line);
        fclose(file);
        free(token_suffix);
        free(token);
        return 1;
      }

      free(target);
      target = next_target;
      matches++;
    }
  }

  free(line);
  fclose(file);

  if (matches == 1 && target != NULL && target[0] != '\0') {
    int result = pm_write_target(target, token_suffix);
    free(target);
    free(token_suffix);
    free(token);
    return result;
  }

  free(target);
  free(token_suffix);
  free(token);
  return 1;
}
