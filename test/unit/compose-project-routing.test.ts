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
      attachedProjectName: "network-a-app-1234",
    },
  ]);

  assert.equal(text, "project\tnetwork-a\tdocker\t/workspace/app\tnetwork-a-app-1234\n");
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
          "docker --context desktop-linux kill abc123",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<--context>\n<desktop-linux>\n<kill>\n<def9876543210000>\n");
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
          "docker kill abc1234567890000",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<kill>\n<def9876543210000>\n");
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
          "docker kill abc1234567890000",
        ].join("\n"),
      ],
      { encoding: "utf8" },
    );

    assert.equal(output, "<kill>\n<def987>\n");
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

test("docker compose wrapper leaves explicit project selections untouched", () => {
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

    assert.equal(output.trim(), "");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function createContainerRoutingRows(projectDir: string): string {
  return serializeComposeProjectRoutingRows([
    {
      networkId: "network-a",
      runtime: "docker",
      workingDirectory: projectDir,
      attachedProjectName: "network-a-app-1234",
      containerMappings: [
        {
          originalContainerId: "abc1234567890000",
          originalContainerName: "workspace-postgres-1",
          attachedContainerId: "def9876543210000",
          attachedContainerName: "network-a-app-postgres-1",
        },
      ],
    },
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
