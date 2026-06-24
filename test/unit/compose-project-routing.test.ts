import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  buildComposeProjectRoutingShell,
  buildRuntimeCommandShimScript,
  serializeComposeProjectRoutingRows,
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

    assert.equal(output, "<stop>\n<def9876543210000>\n");
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

    assert.equal(output, "<stop>\n<seconddef987654>\n");
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

    assert.equal(output, "<exec>\n<-it>\n<def9876543210000>\n<bash>\n<-lc>\n<echo hi>\n");
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

    assert.equal(output, "<kill>\n<--signal>\n<HUP>\n<def9876543210000>\n");
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

    assert.equal(output, "<stop>\n<def9876543210000>\n");
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

    assert.equal(output, "<--context>\n<desktop-linux>\n<logs>\n<def9876543210000>\n");
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

    assert.equal(output, "<logs>\n<def9876543210000>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

    assert.equal(output, "<kill>\n<--signal>\n<HUP>\n<def9876543210000>\n");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

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

    assert.equal(output, "<logs>\n<def987>\n");
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

    assert.equal(output, "<kill>\n<def9876543210000>\n");
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

    assert.equal(output, "<cp>\n<def9876543210000:/tmp/report.txt>\n<./report.txt>\n");
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
