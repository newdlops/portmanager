import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  buildComposeProjectRoutingShell,
  buildRuntimeCommandShimScript,
  inferContainerMappingsFromComposeRoutingFiles,
  serializeComposeProjectRoutingRows,
  splitGeneratedComposeRoutingFiles,
} from "../../src/extension/compose-project-routing";

test("serializes compose clone routing rows for shell lookup", () => {
  const text = serializeComposeProjectRoutingRows([
    {
      networkId: "network-a",
      runtime: "docker",
      workingDirectory: "/workspace/app/",
      composeFiles: ["/workspace/app/docker-compose.yaml"],
      attachedProjectName: "network-a-app-1234",
    },
  ]);

  assert.equal(
    text,
    [
      "project\tnetwork-a\tdocker\t/workspace/app\tnetwork-a-app-1234",
      "file\tnetwork-a\tdocker\t/workspace/app/docker-compose.yaml\tnetwork-a-app-1234\t",
      "",
    ].join("\n"),
  );
});

test("docker compose wrapper targets the attached clone project by cwd and network", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const childDir = path.join(projectDir, "subdir");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(childDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nprintf '%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(childDir)}`,
          "docker compose ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output.trim(), "network-a-app-1234");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper routes as-is attachments by cwd without an original project name", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-as-is-routing-"));
  const projectDir = path.join(tempDir, "workspace", "docker");
  const composeFile = path.join(projectDir, "development.yaml");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(composeFile, "services: {}\n", "utf8");
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        composeFiles: [composeFile],
        attachedProjectName: "c1-docker-98d1ead0",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          `docker compose -f ${shellQuote(composeFile)} up`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(
      output,
      [
        "env=c1-docker-98d1ead0",
        "<compose>",
        "<-f>",
        `<${composeFile}>`,
        "<up>",
        "<--detach>",
        "",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper maps as-is clone container names inferred from generated overrides", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-as-is-container-map-"));
  const projectDir = path.join(tempDir, "workspace", "docker");
  const composeFile = path.join(projectDir, "development.yaml");
  const overrideFile = path.join(tempDir, "c1-docker-98d1ead0.ports.override.yaml");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");
  const attachedProjectName = "c1-docker-98d1ead0";

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(composeFile, "services:\n  db:\n    container_name: captain_db\n", "utf8");
  fs.writeFileSync(
    overrideFile,
    [
      "services:",
      "  'db':",
      "    container_name: 'captain_db-c1-docker-98d1ead0'",
      "    ports: !override",
      "      - '127.0.0.1::5432/tcp'",
      "  'rabbitmq':",
      "    container_name: !reset null",
      "    ports: !override",
      "      - '127.0.0.1::5672/tcp'",
      "",
    ].join("\n"),
    "utf8",
  );
  const routingFiles = splitGeneratedComposeRoutingFiles([composeFile, overrideFile]);
  const containerMappings = inferContainerMappingsFromComposeRoutingFiles({
    attachedProjectName,
    composeFiles: [composeFile, overrideFile],
    serviceNames: ["db", "rabbitmq"],
  });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        composeFiles: routingFiles.composeFiles,
        attachedProjectName,
        overrideFile: routingFiles.overrideFile,
        containerMappings,
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker exec captain_db pg_isready",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<exec>\n<captain_db-c1-docker-98d1ead0>\n<pg_isready>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper targets clone project by compose file outside the project cwd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-file-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const scriptDir = path.join(tempDir, "workspace", "scripts");
  const binDir = path.join(tempDir, "bin");
  const composeFile = path.join(projectDir, "docker", "development.yaml");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(path.dirname(composeFile), { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(composeFile, "services: {}\n", "utf8");
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: path.dirname(composeFile),
        composeFiles: [composeFile],
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(scriptDir)}`,
          `docker compose -f ${shellQuote(composeFile)} -p workspace restart postgres`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(
      output,
      [
        "env=network-a-app-1234",
        "<compose>",
        "<-f>",
        `<${composeFile}>`,
        "<-p>",
        "<network-a-app-1234>",
        "<restart>",
        "<postgres>",
        "",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper appends clone override before the compose subcommand", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-override-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const composeFile = path.join(projectDir, "docker", "development.yaml");
  const overrideFile = path.join(tempDir, "network-a-app-1234.ports.override.yaml");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(path.dirname(composeFile), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(composeFile, "services: {}\n", "utf8");
  fs.writeFileSync(overrideFile, "services: {}\n", "utf8");
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        composeFiles: [composeFile],
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
        overrideFile,
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          `docker compose -f ${shellQuote(composeFile)} up`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(
      output,
      [
        "env=network-a-app-1234",
        "<compose>",
        "<-f>",
        `<${composeFile}>`,
        "<-f>",
        `<${overrideFile}>`,
        "<up>",
        "<--detach>",
        "",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper fails closed when a required clone override is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-missing-override-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const composeFile = path.join(projectDir, "docker", "development.yaml");
  const overrideFile = path.join(tempDir, "network-a-app-1234.ports.override.yaml");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(path.dirname(composeFile), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(composeFile, "services: {}\n", "utf8");
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        composeFiles: [composeFile],
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
        overrideFile,
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    let thrown: unknown;
    try {
      execFileSync(
        "sh",
        [
          "-c",
          [
            buildComposeProjectRoutingShell(routingFile),
            "export PORT_MANAGER_NETWORK_ID=network-a",
            `export PATH=${shellQuote(binDir)}:$PATH`,
            `cd ${shellQuote(projectDir)}`,
            `docker compose -f ${shellQuote(composeFile)} up`,
          ].join("\n"),
        ],
        { encoding: "utf8", stdio: "pipe" },
      );
    } catch (error) {
      thrown = error;
    }

    const failure = thrown as Error & { readonly status?: number; readonly stderr?: string; readonly stdout?: string };
    assert.ok(failure instanceof Error);
    assert.equal(failure.status, 1);
    assert.match(String(failure.stderr), /Port Manager compose routing unavailable/);
    assert.match(String(failure.stderr), new RegExp(escapeRegExp(overrideFile)));
    assert.equal(String(failure.stdout), "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper routes same project name from another worktree", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-worktree-project-routing-"));
  const attachedProjectDir = path.join(tempDir, "worktree-a", "app");
  const otherWorktreeDir = path.join(tempDir, "worktree-b", "app");
  const otherComposeFile = path.join(otherWorktreeDir, "docker", "development.yaml");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(attachedProjectDir, { recursive: true });
  fs.mkdirSync(path.dirname(otherComposeFile), { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(otherComposeFile, "services: {}\n", "utf8");
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: attachedProjectDir,
        composeFiles: [path.join(attachedProjectDir, "docker", "development.yaml")],
        originalProjectName: "workspace",
        attachedProjectName: "network-a-workspace-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(otherWorktreeDir)}`,
          `docker compose -f ${shellQuote(otherComposeFile)} -p workspace restart postgres`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(
      output,
      [
        "env=network-a-workspace-1234",
        "<compose>",
        "<-f>",
        `<${otherComposeFile}>`,
        "<-p>",
        "<network-a-workspace-1234>",
        "<restart>",
        "<postgres>",
        "",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper routes service lifecycle signals by compose project name outside the attached cwd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-worktree-project-routing-"));
  const attachedProjectDir = path.join(tempDir, "worktree-a", "app");
  const otherWorktreeDir = path.join(tempDir, "worktree-b", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(attachedProjectDir, { recursive: true });
  fs.mkdirSync(otherWorktreeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: attachedProjectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-workspace-1234",
        containerMappings: [
          {
            serviceName: "postgres",
            originalContainerId: "abc1234567890000",
            originalContainerName: "workspace-postgres-1",
            attachedContainerId: "def9876543210000",
            attachedContainerName: "network-a-workspace-postgres-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          "export COMPOSE_PROJECT_NAME=workspace",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(otherWorktreeDir)}`,
          "docker stop postgres",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<stop>\n<network-a-workspace-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper prefers per-compose route files inside one network", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-scoped-files-"));
  const firstProjectDir = path.join(tempDir, "workspace", "first");
  const secondProjectDir = path.join(tempDir, "workspace", "second");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

  fs.mkdirSync(firstProjectDir, { recursive: true });
  fs.mkdirSync(secondProjectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, "", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "compose-project-routing-network-a.compose-first.tsv"),
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: firstProjectDir,
        originalProjectName: "first",
        attachedProjectName: "network-a-first-1111",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "compose-project-routing-network-a.compose-second.tsv"),
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: secondProjectDir,
        originalProjectName: "second",
        attachedProjectName: "network-a-second-2222",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nprintf '%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "unset PORT_MANAGER_NETWORK_ID PORT_MANAGER_ROUTE_TABLE_NETWORK_ID PORT_MANAGER_BORROWED_NETWORK_ID NEWDLOPS_PM_NETWORK_ID NEWDLOPS_PM_BORROWED_NETWORK_ID",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(secondProjectDir)}`,
          "docker compose ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output.trim(), "network-a-second-2222");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper resolves duplicate service names from the cwd scoped compose file", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-scoped-service-"));
  const firstProjectDir = path.join(tempDir, "workspace", "first");
  const secondProjectDir = path.join(tempDir, "workspace", "second");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

  fs.mkdirSync(firstProjectDir, { recursive: true });
  fs.mkdirSync(secondProjectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, "", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "compose-project-routing-network-a.compose-first.tsv"),
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: firstProjectDir,
        attachedProjectName: "network-a-first-1111",
        containerMappings: [
          {
            serviceName: "postgres",
            originalContainerId: "firstabc123456",
            originalContainerName: "first-postgres-1",
            attachedContainerId: "firstdef987654",
            attachedContainerName: "network-a-first-postgres-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "compose-project-routing-network-a.compose-second.tsv"),
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: secondProjectDir,
        attachedProjectName: "network-a-second-2222",
        containerMappings: [
          {
            serviceName: "postgres",
            originalContainerId: "secondabc123456",
            originalContainerName: "second-postgres-1",
            attachedContainerId: "seconddef987654",
            attachedContainerName: "network-a-second-postgres-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "unset PORT_MANAGER_NETWORK_ID PORT_MANAGER_ROUTE_TABLE_NETWORK_ID PORT_MANAGER_BORROWED_NETWORK_ID NEWDLOPS_PM_NETWORK_ID NEWDLOPS_PM_BORROWED_NETWORK_ID",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(secondProjectDir)}`,
          "docker stop postgres",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<stop>\n<network-a-second-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper resolves container paths from a parent project cwd", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-parent-cwd-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const composeDir = path.join(projectDir, "docker");
  const otherProjectDir = path.join(tempDir, "workspace", "other");
  const otherComposeDir = path.join(otherProjectDir, "docker");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

  fs.mkdirSync(composeDir, { recursive: true });
  fs.mkdirSync(otherComposeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, "", "utf8");
  fs.writeFileSync(
    path.join(tempDir, "compose-project-routing-network-a.compose-app.tsv"),
    createCaptainDbRoutingRows(composeDir, "pm-captain_db-network-a-app"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(tempDir, "compose-project-routing-network-a.compose-other.tsv"),
    createCaptainDbRoutingRows(otherComposeDir, "pm-captain_db-network-a-other"),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker cp ./db-snapshot/dump.gz captain_db:dump.gz",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<cp>\n<./db-snapshot/dump.gz>\n<pm-captain_db-network-a-app:dump.gz>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper infers network from scoped route file when network env is missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-scoped-route-file-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");
  const scopedRouteFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-a.json");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nprintf '%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          `export PORT_MANAGER_ROUTES_FILE=${shellQuote(scopedRouteFile)}`,
          "unset PORT_MANAGER_NETWORK_ID PORT_MANAGER_ROUTE_TABLE_NETWORK_ID PORT_MANAGER_BORROWED_NETWORK_ID NEWDLOPS_PM_NETWORK_ID NEWDLOPS_PM_BORROWED_NETWORK_ID",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output.trim(), "network-a-app-1234");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites original container id prefixes to the attached clone container", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        attachedProjectName: "network-a-app-1234",
        containerMappings: [
          {
            serviceName: "postgres",
            originalContainerId: "abc1234567890000",
            originalContainerName: "workspace-postgres-1",
            attachedContainerId: "def9876543210000",
            attachedContainerName: "network-a-app-postgres-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker exec -it abc123 bash -lc 'echo hi'",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<exec>\n<-it>\n<network-a-app-postgres-1>\n<bash>\n<-lc>\n<echo hi>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites lifecycle signal commands for original container hashes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-signal-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker kill --signal HUP abc123",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<kill>\n<--signal>\n<HUP>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites stale clone hashes to the current clone hash", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-stale-hash-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        attachedProjectName: "network-a-app-1234",
        containerMappings: [
          {
            serviceName: "postgres",
            originalContainerId: "abc1234567890000",
            originalContainerName: "workspace-postgres-1",
            attachedContainerId: "newdef9876543210",
            attachedContainerName: "network-a-app-postgres-1",
          },
          {
            serviceName: "__portmanager_alias__:postgres",
            originalContainerId: "olddef9876543210",
            originalContainerName: "olddef9876543210",
            attachedContainerId: "newdef9876543210",
            attachedContainerName: "network-a-app-postgres-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker stop olddef9876543210",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<stop>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites lifecycle commands for compose service names", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-service-lifecycle-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker stop postgres",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<stop>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites compose container names without the project prefix", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-name-alias-routing-"));
  const projectDir = path.join(tempDir, "workspace", "captain");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "captain",
        attachedProjectName: "network-a-captain-1234",
        containerMappings: [
          {
            serviceName: "db",
            originalContainerId: "abc1234567890000",
            originalContainerName: "captain_db-1",
            attachedContainerId: "def9876543210000",
            attachedContainerName: "network-a-captain-1234_db-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker logs db-1",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<logs>\n<network-a-captain-1234_db-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites hardcoded compose container names without replica index", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-unindexed-alias-routing-"));
  const projectDir = path.join(tempDir, "workspace", "captain");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "captain",
        attachedProjectName: "network-a-captain-1234",
        containerMappings: [
          {
            serviceName: "db",
            originalContainerId: "abc1234567890000",
            originalContainerName: "captain_db_1",
            attachedContainerId: "def9876543210000",
            attachedContainerName: "pm_captain_db_1_network_a_1234",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker exec captain_db psql",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<exec>\n<pm_captain_db_1_network_a_1234>\n<psql>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites container hashes after Docker global options", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-global-option-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker --context desktop-linux logs abc123",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<--context>\n<desktop-linux>\n<logs>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites container hashes outside the compose working directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-outside-cwd-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app", "docker");
  const serverDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(serverDir)}`,
          "docker logs abc1234567890000",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<logs>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  "bash shell wrapper rewrites hardcoded absolute docker paths",
  { skip: fs.existsSync("/bin/bash") ? false : "bash is not available" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-absolute-path-routing-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const binDir = path.join(tempDir, "bin");
    const routingFile = path.join(tempDir, "routes.tsv");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
    fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
      encoding: "utf8",
      mode: 0o700,
    });

    try {
      const output = execFileSync(
        "/bin/bash",
        [
          "-c",
          [
            buildComposeProjectRoutingShell(routingFile),
            "export PORT_MANAGER_NETWORK_ID=network-a",
            `export PATH=${shellQuote(binDir)}:$PATH`,
            `cd ${shellQuote(projectDir)}`,
            "/usr/local/bin/docker exec abc123 psql",
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );

      assert.equal(output, "<exec>\n<network-a-app-postgres-1>\n<psql>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test("docker PATH shim rewrites child process docker invocations without shell functions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-path-shim-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const shimDir = path.join(tempDir, "shim");
  const realBinDir = path.join(tempDir, "real-bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(realBinDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(shimDir, "docker"), buildRuntimeCommandShimScript("docker"), {
    encoding: "utf8",
    mode: 0o700,
  });
  fs.writeFileSync(path.join(realBinDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync("docker", ["kill", "--signal", "HUP", "abc123"], {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
        PORT_MANAGER_NETWORK_ID: "network-a",
      },
    });

    assert.equal(output, "<kill>\n<--signal>\n<HUP>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker PATH shim signals terminal marker after compose lifecycle commands", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-path-shim-signal-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const shimDir = path.join(tempDir, "shim");
  const realBinDir = path.join(tempDir, "real-bin");
  const markerDir = path.join(tempDir, "markers");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(realBinDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(shimDir, "docker"), buildRuntimeCommandShimScript("docker"), {
    encoding: "utf8",
    mode: 0o700,
  });
  fs.writeFileSync(path.join(realBinDir, "docker"), "#!/bin/sh\nexit 0\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    execFileSync("docker", ["compose", "-p", "workspace", "up", "db"], {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
        PORT_MANAGER_NETWORK_ID: "network-a",
        PORT_MANAGER_TERMINAL_ATTACHMENT_DIR: markerDir,
      },
    });

    const markerFiles = fs.readdirSync(markerDir).filter((entry) => entry.endsWith(".tsv"));
    assert.equal(markerFiles.length, 1);
    const markerText = fs.readFileSync(path.join(markerDir, markerFiles[0]!), "utf8");
    assert.equal(markerText.split("\t")[0], "network-a");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites ps name filters for cloned compose containers", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-ps-name-filter-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker ps -qf name=workspace-postgres-1",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<ps>\n<-qf>\n<name=network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper preserves anchored ps name filters while routing container names", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-anchored-ps-name-filter-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker ps --filter=name=^/workspace-postgres-1$",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<ps>\n<--filter=name=^/network-a-app-postgres-1$>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  "zsh docker wrapper preserves anchored ps name filters while routing container names",
  { skip: fs.existsSync("/bin/zsh") ? false : "zsh is not available" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-zsh-container-anchored-ps-name-filter-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const binDir = path.join(tempDir, "bin");
    const routingFile = path.join(tempDir, "routes.tsv");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
    fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
      encoding: "utf8",
      mode: 0o700,
    });

    try {
      const output = execFileSync(
        "/bin/zsh",
        [
          "-c",
          [
            buildComposeProjectRoutingShell(routingFile),
            "export PORT_MANAGER_NETWORK_ID=network-a",
            `export PATH=${shellQuote(binDir)}:$PATH`,
            `cd ${shellQuote(projectDir)}`,
            "docker ps --filter=name=^/workspace-postgres-1$",
          ].join("\n"),
        ],
        { encoding: "utf8" },
      );

      assert.equal(output, "<ps>\n<--filter=name=^/network-a-app-postgres-1$>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim rewrites ps name filters for cloned compose containers",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-ps-name-filter-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(path.join(realBinDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
      encoding: "utf8",
      mode: 0o700,
    });

    try {
      const output = execFileSync("docker", ["ps", "-qf", "name=workspace-postgres-1"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "<ps>\n<-qf>\n<name=network-a-app-postgres-1>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim preserves anchored ps name filters while routing container names",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-anchored-ps-name-filter-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(path.join(realBinDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
      encoding: "utf8",
      mode: 0o700,
    });

    try {
      const output = execFileSync("docker", ["ps", "--filter=name=^/workspace-postgres-1$"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "<ps>\n<--filter=name=^/network-a-app-postgres-1$>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test("docker-compose PATH shim rewrites standalone compose project selections", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-standalone-compose-path-shim-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const shimDir = path.join(tempDir, "shim");
  const realBinDir = path.join(tempDir, "real-bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(realBinDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(shimDir, "docker-compose"), buildRuntimeCommandShimScript("docker-compose"), {
    encoding: "utf8",
    mode: 0o700,
  });
  fs.writeFileSync(
    path.join(realBinDir, "docker-compose"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync("docker-compose", ["-p", "workspace", "ps"], {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
        PORT_MANAGER_NETWORK_ID: "network-a",
      },
    });

    assert.equal(output, "env=network-a-app-1234\n<-p>\n<network-a-app-1234>\n<ps>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker-compose PATH shim rewrites standalone compose lifecycle commands", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-standalone-compose-lifecycle-shim-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const shimDir = path.join(tempDir, "shim");
  const realBinDir = path.join(tempDir, "real-bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(shimDir, { recursive: true });
  fs.mkdirSync(realBinDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(shimDir, "docker-compose"), buildRuntimeCommandShimScript("docker-compose"), {
    encoding: "utf8",
    mode: 0o700,
  });
  fs.writeFileSync(
    path.join(realBinDir, "docker-compose"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync("docker-compose", ["-p", "workspace", "restart", "postgres"], {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
        PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
        PORT_MANAGER_NETWORK_ID: "network-a",
      },
    });

    assert.equal(output, "env=network-a-app-1234\n<-p>\n<network-a-app-1234>\n<restart>\n<postgres>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites full container hashes when stored mapping is short", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-full-hash-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        attachedProjectName: "network-a-app-1234",
        containerMappings: [
          {
            serviceName: "postgres",
            originalContainerId: "abc123",
            originalContainerName: "workspace-postgres-1",
            attachedContainerId: "def987",
            attachedContainerName: "network-a-app-postgres-1",
          },
        ],
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker logs abc1234567890000",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<logs>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper routes lifecycle commands that already target attached clone hashes", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-attached-container-lifecycle-route-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker kill def9876543210000",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<kill>\n<network-a-app-postgres-1>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper targets clone project after Docker global options", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-global-option-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nprintf '%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker --context desktop-linux compose ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output.trim(), "network-a-app-1234");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper rewrites explicit original project selections to the attached clone", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-explicit-original-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose -p workspace ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "env=network-a-app-1234\n<compose>\n<-p>\n<network-a-app-1234>\n<ps>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper rewrites lifecycle commands for explicit original project selections", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-explicit-original-lifecycle-route-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose -p workspace restart postgres",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "env=network-a-app-1234\n<compose>\n<-p>\n<network-a-app-1234>\n<restart>\n<postgres>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper rewrites COMPOSE_PROJECT_NAME for the original project only", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-env-original-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nprintf '%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "COMPOSE_PROJECT_NAME=workspace docker compose ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output.trim(), "network-a-app-1234");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper rewrites container path arguments for cp", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-cp-routing-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createContainerRoutingRows(projectDir), "utf8");
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker cp abc123:/tmp/report.txt ./report.txt",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<cp>\n<network-a-app-postgres-1:/tmp/report.txt>\n<./report.txt>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper prefers native container mapper when available", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-map-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");
  const helperPath = path.join(tempDir, "portmanager_container_map");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, "", "utf8");
  fs.writeFileSync(
    helperPath,
    "#!/bin/sh\nif [ \"$4\" = \"abc123\" ]; then printf '%s\\n' native-def987; exit 0; fi\nexit 1\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile, helperPath),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker kill abc123",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<kill>\n<native-def987>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper preserves container path suffixes from native container mapper", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-map-suffix-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");
  const helperPath = path.join(tempDir, "portmanager_container_map");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, "", "utf8");
  fs.writeFileSync(
    helperPath,
    "#!/bin/sh\nif [ \"$4\" = \"captain_db\" ]; then printf '%s\\n' pm-captain_db-network-a; exit 0; fi\nexit 1\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile, helperPath),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker cp ./db-snapshot/dump.gz captain_db:dump.gz",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<cp>\n<./db-snapshot/dump.gz>\n<pm-captain_db-network-a:dump.gz>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker wrapper preserves single quotes inside bash commands", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-container-command-quote-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const composeDir = path.join(projectDir, "docker");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

  fs.mkdirSync(composeDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(routingFile, createCaptainDbRoutingRows(composeDir, "pm-captain_db-network-a"), "utf8");
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\ni=0\nfor arg in \"$@\"; do i=$((i + 1)); printf '%s=<%s>\\n' \"$i\" \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          `docker exec -i captain_db bash -c "psql -U postgres dummy -c \\"SELECT 1 FROM pg_stat_activity WHERE datname = 'postgres'\\""`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(
      output,
      [
        "1=<exec>",
        "2=<-i>",
        "3=<pm-captain_db-network-a>",
        "4=<bash>",
        "5=<-c>",
        `6=<psql -U postgres dummy -c "SELECT 1 FROM pg_stat_activity WHERE datname = 'postgres'">`,
        "",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper forces explicit project selections to the attached clone", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-routing-explicit-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nprintf '%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose --project-name manual ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output.trim(), "network-a-app-1234");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper detaches routed clone up commands from terminal lifetime", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-up-detach-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose -p workspace up db",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "env=network-a-app-1234\n<compose>\n<-p>\n<network-a-app-1234>\n<up>\n<--detach>\n<db>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper signals terminal marker after routed lifecycle commands", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-up-signal-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const markerDir = path.join(tempDir, "markers");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nexit 0\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PORT_MANAGER_TERMINAL_ATTACHMENT_DIR=${shellQuote(markerDir)}`,
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose -p workspace up db",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    const markerFiles = fs.readdirSync(markerDir).filter((entry) => entry.endsWith(".tsv"));
    assert.equal(markerFiles.length, 1);
    const markerText = fs.readFileSync(path.join(markerDir, markerFiles[0]!), "utf8");
    assert.equal(markerText.split("\t")[0], "network-a");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper does not signal terminal marker for read-only commands", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-ps-no-signal-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const markerDir = path.join(tempDir, "markers");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(markerDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nexit 0\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PORT_MANAGER_TERMINAL_ATTACHMENT_DIR=${shellQuote(markerDir)}`,
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose ps",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.deepEqual(fs.readdirSync(markerDir), []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper detaches file-routed up commands without an explicit project flag", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-file-up-detach-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const scriptDir = path.join(tempDir, "workspace", "scripts");
  const binDir = path.join(tempDir, "bin");
  const composeFile = path.join(projectDir, "docker", "development.yaml");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(path.dirname(composeFile), { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(composeFile, "services: {}\n", "utf8");
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        composeFiles: [composeFile],
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(
    path.join(binDir, "docker"),
    "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
    {
      encoding: "utf8",
      mode: 0o700,
    },
  );

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(scriptDir)}`,
          `docker compose -f ${shellQuote(composeFile)} up`,
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(
      output,
      [
        "env=network-a-app-1234",
        "<compose>",
        "<-f>",
        `<${composeFile}>`,
        "<up>",
        "<--detach>",
        "",
      ].join("\n"),
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("docker compose wrapper preserves explicit routed foreground up options", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-compose-up-foreground-"));
  const projectDir = path.join(tempDir, "workspace", "app");
  const binDir = path.join(tempDir, "bin");
  const routingFile = path.join(tempDir, "routes.tsv");

  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    routingFile,
    serializeComposeProjectRoutingRows([
      {
        networkId: "network-a",
        runtime: "docker",
        workingDirectory: projectDir,
        originalProjectName: "workspace",
        attachedProjectName: "network-a-app-1234",
      },
    ]),
    "utf8",
  );
  fs.writeFileSync(path.join(binDir, "docker"), "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n", {
    encoding: "utf8",
    mode: 0o700,
  });

  try {
    const output = execFileSync(
      "sh",
      [
        "-c",
        [
          buildComposeProjectRoutingShell(routingFile),
          "export PORT_MANAGER_NETWORK_ID=network-a",
          `export PATH=${shellQuote(binDir)}:$PATH`,
          `cd ${shellQuote(projectDir)}`,
          "docker compose -p workspace up --abort-on-container-exit db",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<compose>\n<-p>\n<network-a-app-1234>\n<up>\n<--abort-on-container-exit>\n<db>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test(
  "native docker PATH shim prefers per-compose route files inside one network",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-scoped-files-"));
    const firstProjectDir = path.join(tempDir, "workspace", "first");
    const secondProjectDir = path.join(tempDir, "workspace", "second");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

    fs.mkdirSync(firstProjectDir, { recursive: true });
    fs.mkdirSync(secondProjectDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "compose-project-routing-network-a.compose-first.tsv"),
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: firstProjectDir,
          originalProjectName: "first",
          attachedProjectName: "network-a-first-1111",
        },
      ]),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempDir, "compose-project-routing-network-a.compose-second.tsv"),
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: secondProjectDir,
          originalProjectName: "second",
          attachedProjectName: "network-a-second-2222",
        },
      ]),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["compose", "-p", "second", "ps"], {
        cwd: secondProjectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(
        output,
        [
          "env=network-a-second-2222",
          "<compose>",
          "<-p>",
          "<network-a-second-2222>",
          "<ps>",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim resolves container paths from a parent project cwd",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-parent-cwd-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const composeDir = path.join(projectDir, "docker");
    const otherProjectDir = path.join(tempDir, "workspace", "other");
    const otherComposeDir = path.join(otherProjectDir, "docker");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(otherComposeDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "compose-project-routing-network-a.compose-app.tsv"),
      createCaptainDbRoutingRows(composeDir, "pm-captain_db-network-a-app"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempDir, "compose-project-routing-network-a.compose-other.tsv"),
      createCaptainDbRoutingRows(otherComposeDir, "pm-captain_db-network-a-other"),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["cp", "./db-snapshot/dump.gz", "captain_db:dump.gz"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "<cp>\n<./db-snapshot/dump.gz>\n<pm-captain_db-network-a-app:dump.gz>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim detaches routed clone up commands",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-up-detach-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(
      routingFile,
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: projectDir,
          originalProjectName: "workspace",
          attachedProjectName: "network-a-workspace-1234",
        },
      ]),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["compose", "-p", "workspace", "up", "db"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "env=network-a-workspace-1234\n<compose>\n<-p>\n<network-a-workspace-1234>\n<up>\n<--detach>\n<db>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim detaches file-routed up commands without an explicit project flag",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-file-up-detach-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const scriptDir = path.join(tempDir, "workspace", "scripts");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const composeFile = path.join(projectDir, "docker", "development.yaml");
    const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

    fs.mkdirSync(path.dirname(composeFile), { recursive: true });
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(composeFile, "services: {}\n", "utf8");
    fs.writeFileSync(
      routingFile,
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: projectDir,
          composeFiles: [composeFile],
          originalProjectName: "workspace",
          attachedProjectName: "network-a-app-1234",
        },
      ]),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["compose", "-f", composeFile, "up"], {
        cwd: scriptDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(
        output,
        [
          "env=network-a-app-1234",
          "<compose>",
          "<-f>",
          `<${composeFile}>`,
          "<up>",
          "<--detach>",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim signals terminal marker after file-routed lifecycle commands",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-file-up-signal-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const scriptDir = path.join(tempDir, "workspace", "scripts");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const markerDir = path.join(tempDir, "markers");
    const composeFile = path.join(projectDir, "docker", "development.yaml");
    const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

    fs.mkdirSync(path.dirname(composeFile), { recursive: true });
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(composeFile, "services: {}\n", "utf8");
    fs.writeFileSync(
      routingFile,
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: projectDir,
          composeFiles: [composeFile],
          originalProjectName: "workspace",
          attachedProjectName: "network-a-app-1234",
        },
      ]),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(path.join(realBinDir, "docker"), "#!/bin/sh\nexit 0\n", {
      encoding: "utf8",
      mode: 0o700,
    });

    try {
      execFileSync("docker", ["compose", "-f", composeFile, "up"], {
        cwd: scriptDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_TERMINAL_ATTACHMENT_DIR: markerDir,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      const markerFiles = fs.readdirSync(markerDir).filter((entry) => entry.endsWith(".tsv"));
      assert.equal(markerFiles.length, 1);
      const markerText = fs.readFileSync(path.join(markerDir, markerFiles[0]!), "utf8");
      assert.equal(markerText.split("\t")[0], "network-a");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim routes same project name from another worktree",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-worktree-project-"));
    const attachedProjectDir = path.join(tempDir, "worktree-a", "app");
    const otherWorktreeDir = path.join(tempDir, "worktree-b", "app");
    const otherComposeFile = path.join(otherWorktreeDir, "docker", "development.yaml");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "compose-project-routing-network-a.tsv");

    fs.mkdirSync(attachedProjectDir, { recursive: true });
    fs.mkdirSync(path.dirname(otherComposeFile), { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(otherComposeFile, "services: {}\n", "utf8");
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(
      path.join(tempDir, "compose-project-routing-network-a.compose-workspace.tsv"),
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: attachedProjectDir,
          composeFiles: [path.join(attachedProjectDir, "docker", "development.yaml")],
          originalProjectName: "workspace",
          attachedProjectName: "network-a-workspace-1234",
        },
      ]),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["compose", "-f", otherComposeFile, "-p", "workspace", "restart", "postgres"], {
        cwd: otherWorktreeDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_NETWORK_ID: "network-a",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(
        output,
        [
          "env=network-a-workspace-1234",
          "<compose>",
          "<-f>",
          `<${otherComposeFile}>`,
          "<-p>",
          "<network-a-workspace-1234>",
          "<restart>",
          "<postgres>",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim recovers compose project from route table when routing TSV is empty",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-route-fallback-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const composeDir = path.join(projectDir, "docker");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");
    const routeTableFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-a.json");

    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(
      routeTableFile,
      JSON.stringify({
        updatedAt: "2026-06-24T00:00:00Z",
        routes: [
          {
            logicalPort: 65394,
            actualPort: 65394,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: composeDir,
            networkId: "network-a",
            processId: "managed-process-7",
            processName: "c1-docker-691afbc8:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["compose", "-p", "docker", "-f", "./docker/development.yaml", "stop", "db"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_ROUTES_FILE: routeTableFile,
          PORT_MANAGER_NETWORK_ID: "",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(
        output,
        [
          "env=c1-docker-691afbc8",
          "<compose>",
          "<-p>",
          "<c1-docker-691afbc8>",
          "<-f>",
          "<./docker/development.yaml>",
          "<stop>",
          "<db>",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim prefers the current network route table over stale route env",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-compose-route-network-scope-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const composeDir = path.join(projectDir, "docker");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");
    const globalRouteTableFile = path.join(tempDir, "newdlops-portmanager-routes-501.json");
    const staleRouteTableFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-a.json");
    const currentRouteTableFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-b.json");

    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(globalRouteTableFile, JSON.stringify({ updatedAt: "2026-06-24T00:00:00Z", routes: [] }), "utf8");
    fs.writeFileSync(staleRouteTableFile, createRouteTableJson(composeDir, "network-a", "network-a-app-1234"), "utf8");
    fs.writeFileSync(currentRouteTableFile, createRouteTableJson(composeDir, "network-b", "network-b-app-5678"), "utf8");
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      "#!/bin/sh\nprintf 'env=%s\\n' \"${COMPOSE_PROJECT_NAME:-}\"\nfor arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done\n",
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["compose", "-p", "docker", "-f", "./docker/development.yaml", "stop", "db"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_ROUTES_FILE: staleRouteTableFile,
          PORT_MANAGER_GLOBAL_ROUTES_FILE: globalRouteTableFile,
          PORT_MANAGER_NETWORK_ID: "network-b",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(
        output,
        [
          "env=network-b-app-5678",
          "<compose>",
          "<-p>",
          "<network-b-app-5678>",
          "<-f>",
          "<./docker/development.yaml>",
          "<stop>",
          "<db>",
          "",
        ].join("\n"),
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim recovers container hash routing from labels and route table when routing TSV is empty",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-route-fallback-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const composeDir = path.join(projectDir, "docker");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");
    const routeTableFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-a.json");

    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(
      routeTableFile,
      JSON.stringify({
        updatedAt: "2026-06-24T00:00:00Z",
        routes: [
          {
            logicalPort: 65394,
            actualPort: 65394,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: composeDir,
            networkId: "network-a",
            processId: "managed-process-7",
            processName: "c1-docker-691afbc8:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"inspect\" ] && [ \"$2\" = \"--format\" ] && [ \"$4\" = \"original-db-123456\" ]; then",
        "  printf 'original-db-123456\\t/captain_db\\tdocker\\tdb\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"container\" ] && [ \"$2\" = \"ls\" ]; then",
        "  printf 'clone-db-987654\\n'",
        "  exit 0",
        "fi",
        "for arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done",
        "",
      ].join("\n"),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["exec", "original-db-123456", "psql"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_ROUTES_FILE: routeTableFile,
          PORT_MANAGER_NETWORK_ID: "",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "<exec>\n<clone-db-987654>\n<psql>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim recovers hardcoded container names from route table when inspect cannot resolve the original",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-container-name-route-fallback-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const composeDir = path.join(projectDir, "docker");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");
    const routeTableFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-a.json");

    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(routingFile, "", "utf8");
    fs.writeFileSync(
      routeTableFile,
      JSON.stringify({
        updatedAt: "2026-06-24T00:00:00Z",
        routes: [
          {
            logicalPort: 15432,
            actualPort: 57001,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: composeDir,
            networkId: "network-a",
            processId: "managed-process-7",
            processName: "c1-docker-691afbc8:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"inspect\" ]; then",
        "  exit 1",
        "fi",
        "if [ \"$1\" = \"container\" ] && [ \"$2\" = \"ls\" ]; then",
        "  printf 'clone-db-987654\\n'",
        "  exit 0",
        "fi",
        "for arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done",
        "",
      ].join("\n"),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["cp", "./db-snapshot/dump.gz", "captain_db:dump.gz"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_ROUTES_FILE: routeTableFile,
          PORT_MANAGER_NETWORK_ID: "",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "<cp>\n<./db-snapshot/dump.gz>\n<clone-db-987654:dump.gz>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

test(
  "native docker PATH shim rewrites stale stopped clone hashes to the current clone",
  { skip: canRunNativeDockerShim() ? false : "native docker shim is not runnable on this platform" },
  () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "portmanager-native-stale-clone-route-"));
    const projectDir = path.join(tempDir, "workspace", "app");
    const composeDir = path.join(projectDir, "docker");
    const shimDir = path.join(tempDir, "shim");
    const realBinDir = path.join(tempDir, "real-bin");
    const routingFile = path.join(tempDir, "routes.tsv");
    const routeTableFile = path.join(tempDir, "newdlops-portmanager-routes-501-network-a.json");

    fs.mkdirSync(composeDir, { recursive: true });
    fs.mkdirSync(shimDir, { recursive: true });
    fs.mkdirSync(realBinDir, { recursive: true });
    fs.writeFileSync(
      routingFile,
      serializeComposeProjectRoutingRows([
        {
          networkId: "network-a",
          runtime: "docker",
          workingDirectory: projectDir,
          originalProjectName: "docker",
          attachedProjectName: "network-a-app-1234",
          containerMappings: [
            {
              serviceName: "db",
              originalContainerId: "original-db-123456",
              originalContainerName: "captain_db",
              attachedContainerId: "stale-db-111111",
              attachedContainerName: "stale-db-111111",
            },
          ],
        },
      ]),
      "utf8",
    );
    fs.writeFileSync(
      routeTableFile,
      JSON.stringify({
        updatedAt: "2026-06-24T00:00:00Z",
        routes: [
          {
            logicalPort: 15432,
            actualPort: 57001,
            routeDirection: "listen",
            host: "127.0.0.1",
            cwd: composeDir,
            networkId: "network-a",
            processId: "managed-process-7",
            processName: "network-a-app-1234:db/postgresql",
            status: "running",
            source: "compose",
          },
        ],
      }),
      "utf8",
    );
    fs.symlinkSync(getNativeDockerShimPath(), path.join(shimDir, "docker"));
    fs.writeFileSync(
      path.join(realBinDir, "docker"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"inspect\" ] && [ \"$2\" = \"--format\" ] && [ \"$3\" = \"{{.State.Running}}\" ] && [ \"$4\" = \"stale-db-111111\" ]; then",
        "  printf 'false\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"inspect\" ] && [ \"$2\" = \"--format\" ] && [ \"$4\" = \"stale-db-111111\" ]; then",
        "  printf 'stale-db-111111\\t/stale-db-111111\\tnetwork-a-app-1234\\tdb\\n'",
        "  exit 0",
        "fi",
        "if [ \"$1\" = \"container\" ] && [ \"$2\" = \"ls\" ]; then",
        "  printf 'current-db-222222\\n'",
        "  exit 0",
        "fi",
        "for arg in \"$@\"; do printf '<%s>\\n' \"$arg\"; done",
        "",
      ].join("\n"),
      {
        encoding: "utf8",
        mode: 0o700,
      },
    );

    try {
      const output = execFileSync("docker", ["exec", "stale-db-111111", "psql"], {
        cwd: projectDir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${shimDir}${path.delimiter}${realBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
          PORT_MANAGER_RUNTIME_SHIM_DIR: shimDir,
          PORT_MANAGER_COMPOSE_ROUTING_FILE: routingFile,
          PORT_MANAGER_ROUTES_FILE: routeTableFile,
          PORT_MANAGER_NETWORK_ID: "",
          PORT_MANAGER_BORROWED_NETWORK_ID: "",
          NEWDLOPS_PM_NETWORK_ID: "",
          NEWDLOPS_PM_BORROWED_NETWORK_ID: "",
        },
      });

      assert.equal(output, "<exec>\n<current-db-222222>\n<psql>\n");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  },
);

function createContainerRoutingRows(projectDir: string): string {
  return serializeComposeProjectRoutingRows([
    {
      networkId: "network-a",
      runtime: "docker",
      workingDirectory: projectDir,
      attachedProjectName: "network-a-app-1234",
      containerMappings: [
        {
          serviceName: "postgres",
          originalContainerId: "abc1234567890000",
          originalContainerName: "workspace-postgres-1",
          attachedContainerId: "def9876543210000",
          attachedContainerName: "network-a-app-postgres-1",
        },
      ],
    },
  ]);
}

function createCaptainDbRoutingRows(workingDirectory: string, attachedContainerName: string): string {
  return serializeComposeProjectRoutingRows([
    {
      networkId: "network-a",
      runtime: "docker",
      workingDirectory,
      attachedProjectName: attachedContainerName.replace(/^pm-captain_db-/, ""),
      containerMappings: [
        {
          serviceName: "db",
          originalContainerId: "originalcaptain0001",
          originalContainerName: "captain_db",
          attachedContainerId: "attachedcaptain0001",
          attachedContainerName,
        },
      ],
    },
  ]);
}

function createRouteTableJson(composeDir: string, networkId: string, projectName: string): string {
  return JSON.stringify({
    updatedAt: "2026-06-24T00:00:00Z",
    routes: [
      {
        logicalPort: 15432,
        actualPort: 57001,
        routeDirection: "listen",
        host: "127.0.0.1",
        cwd: composeDir,
        networkId,
        processId: `managed-process-${networkId}`,
        processName: `${projectName}:db/postgresql`,
        status: "running",
        source: "compose",
      },
    ],
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getNativeDockerShimPath(): string {
  return path.join(process.cwd(), "media", "native", "portmanager_docker_shim");
}

function canRunNativeDockerShim(): boolean {
  const nativeDockerShimPath = getNativeDockerShimPath();

  try {
    fs.accessSync(nativeDockerShimPath, fs.constants.X_OK);
    execFileSync(nativeDockerShimPath, [], { stdio: "pipe" });
    return false;
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException & { status?: number; stderr?: Buffer };
    return typedError.status === 127 && typedError.stderr?.includes("invoke through docker") === true;
  }
}
