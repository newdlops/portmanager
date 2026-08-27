# Publishing Port Manager

This document is the release checklist for publishing `newdlops.portmanager` to the Visual Studio Marketplace.

## Publisher Identity

- Publisher ID: `newdlops`
- Extension name: `portmanager`
- Marketplace extension ID: `newdlops.portmanager`
- Display name: `Port Manager`
- Repository: `https://github.com/newdlops/portmanager`
- Initial version: `0.0.1`
- Release channel: general release

Before every publish, verify `package.json` still uses `"publisher": "newdlops"` and `"name": "portmanager"`. The Marketplace extension ID is derived from those two fields; changing either one publishes a different extension identity.

If the GitHub repository moves, update the `repository`, `bugs`, and `homepage` metadata before packaging. Do not publish while those URLs point at the wrong project.

## Prerequisites

- Visual Studio Marketplace publisher `newdlops` exists and the publishing account has access to it.
- `npx vsce login newdlops` has been completed on the publishing machine, or the release environment provides a valid Marketplace token.
- `README.md` describes the current user-facing behavior.
- `CHANGELOG.md` has an entry for the version in `package.json`.
- `package.json` version, publisher, repository, bugs, homepage, icon, keywords, and categories have been reviewed.
- The worktree contains only intentional release changes. Do not revert unrelated files owned by another worker; pause and coordinate if unrelated changes make the release state unclear.
- A C compiler is available for release builds that should include native hook support.
- On macOS, `codesign` is available so native hook artifacts are explicitly signed after rebuild.

## Native Runtime Build And Targeting

Native routing is required product functionality. Packaging fails if the C
compiler, target architecture, macOS deployment baseline, or code signature is
wrong; it never silently ships stale binaries. The installed extension also
checks the Mach-O CPU directly, probes the native agent, and preloads the hook
through the OS loader before reporting setup success. This deliberately rejects
an Intel VSIX inside Apple Silicon VS Code even when Rosetta could launch its
standalone agent.
Build the current machine's target with:

```sh
npm run build:hook
```

`npm run package` and `npm run publish` infer the current supported target and
pass it through `vsce --target`. Their `vscode:prepublish` hook runs:

```sh
npm run compile && npm run build:hook
```

Each published VSIX must be target-specific:

- `darwin-arm64`: `npm run package:darwin-arm64`
- `darwin-x64`: `npm run package:darwin-x64`
- `linux-arm64`: `npm run package:linux-arm64`
- `linux-x64`: `npm run package:linux-x64`

macOS may cross-compile its two architectures with `-arch`; Linux packages must
run on a matching architecture. macOS artifacts target macOS 11.0 by default
(`PORT_MANAGER_MACOS_DEPLOYMENT_TARGET` can change the declared baseline) and
are ad-hoc signed after compilation. The build removes the opposite platform's
hook and verifies every expected helper with `file`, `otool`, and `codesign`.
On a runner whose native CPU matches the target, verification also preloads the
hook into the agent and executes its side-effect-free parser probe. Cross-built
macOS artifacts still require the matching native clean-machine run below.
Never publish a generic VSIX containing whichever binaries happened to be in
`media/native`.

For a macOS release build, the automated verifier runs during the build. It can
also be invoked directly after building the current target:

```sh
npm run verify:native
```

## Build, Test, And Package

Install dependencies once for the release checkout:

```sh
npm install
```

Run unit tests first, then run the package command for every release target on
an appropriate runner:

```sh
npm test
npm run package:darwin-arm64
npm run package:darwin-x64
# On matching Linux runners:
npm run package:linux-arm64
npm run package:linux-x64
```

`npm run publish:precheck` remains a convenient precheck for the current
machine's inferred target; it runs the unit suite and then packages. The release
flow runs unit tests once, while every target-specific package performs:

- TypeScript compilation through `vscode:prepublish`
- native hook build through `vscode:prepublish` during VSIX packaging
- architecture/minimum-OS/signature verification
- VSIX packaging through `vsce package --target <target>`

The package command produces a target-tagged file such as:

```text
portmanager-darwin-arm64-0.0.1.vsix
```

If you only need to rebuild the current platform's VSIX after a successful test
run:

```sh
npm run package
```

## VSIX Install Verification

Install the generated VSIX before publishing:

```sh
code --install-extension portmanager-darwin-arm64-0.0.1.vsix --force
```

For a cleaner manual check, install into temporary VS Code profile directories:

```sh
code --user-data-dir /tmp/portmanager-vsix-user --extensions-dir /tmp/portmanager-vsix-ext --install-extension portmanager-darwin-arm64-0.0.1.vsix --force
code --user-data-dir /tmp/portmanager-vsix-user --extensions-dir /tmp/portmanager-vsix-ext
```

Verify each VSIX on a clean machine or VM that matches its target, not only on
the release workstation:

- Test both a native Apple Silicon VS Code install with `darwin-arm64` and a
  native Intel VS Code install with `darwin-x64`. Rosetta is not an Intel test.
- Use a new macOS user or disposable VM with no existing `~/.portmanager`, Port
  Manager Keychain trust, `/etc/resolver` rows, or Port Manager `/etc/hosts`
  block. An admin-capable account is required for the one-time system setup.
- The installed extension ID is `newdlops.portmanager`.
- The Port Manager activity bar view appears.
- `Initialize This Worktree` creates one default network and opens a routed terminal.
- From a source repository with a running Compose project, `Create Isolated
  Worktree` creates a sibling Git worktree, one dedicated network, a distinct
  hidden Compose project, and a new VS Code window whose first terminal is
  attached automatically. Confirm repository bind mounts resolve inside the
  target worktree, not the source checkout.
- Cancel or fail the isolated-worktree flow after Git creation and after network
  creation, then retry the same branch. It must reuse the exact worktree/network
  and must not duplicate Compose attachments.
- A new terminal can run `pm status` without manual PATH or profile edits.
- Test the default zsh profile and a bash profile. Both must expose `pm` in a
  newly opened shell after initialization.
- On macOS, Browser access & DNS reports the DNS responder running and TLS Trust
  as trusted after the one-time approval. Setup success must include actual
  system-resolution checks for both `<network>` and `<network>.pm`, not only
  generated resolver files.
- Confirm the default Keychain search list validates the real leaf for its
  alias (do not pass the Port Manager root through `security -r`):

    ```sh
    security verify-cert -c "/Library/Application Support/PortManager/browser-tls/portmanager-browser.crt" -p ssl -n '<network>.pm' -L -q
    ```
- Logical network creation, terminal refresh, and host port exposure commands are present.
- The README, changelog, settings, command list, and Marketplace icon render correctly in the extension details page.
- On supported platforms, the native hook artifacts are present under the installed extension's `media/native` directory.

## Publish

Publish only after the target prechecks and clean-machine VSIX verification pass.
Run the publish script on the matching target runner:

```sh
npm run publish
```

For a package that was already verified and should be uploaded unchanged, publish that exact VSIX:

```sh
npx vsce publish --packagePath portmanager-darwin-arm64-0.0.1.vsix
```

After publishing, verify the Marketplace page:

- Extension ID is `newdlops.portmanager`.
- Publisher is `newdlops`.
- Display name is `Port Manager`.
- README and CHANGELOG render correctly.
- Repository, issue, and homepage links point to `newdlops/portmanager`.
- Command list, settings, categories, and icon match `package.json`.
- A clean VS Code profile can install the Marketplace version.

## Versioning

Update `CHANGELOG.md` before every publish.

Use SemVer for `package.json`:

- `0.0.x`: patch fixes
- `0.x.0`: feature additions before `1.0.0`
- `1.0.0`: stable release

Update `package.json` and `CHANGELOG.md` in a separate commit, build every
target-specific VSIX for that exact version, then upload only the verified
artifacts. Do not use a bare `vsce publish patch`: it can bypass the target
wrapper and build a generic package with host-specific native files.

## Token Handling

Do not commit Marketplace tokens or paste them into tracked files. For long-term automated publishing, prefer Microsoft Entra ID based automation over long-lived PAT storage. Personal access tokens should be treated as secrets and kept out of the repository.
