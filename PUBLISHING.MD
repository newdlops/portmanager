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

## Native Hook Build And Codesign

The VSIX includes native hook artifacts from `media/native` when they can be built on the release machine. The build is driven by:

```sh
npm run build:hook
```

`npm run package` and `npm run publish` also invoke `vscode:prepublish`, which runs:

```sh
npm run compile && npm run build:hook
```

Platform behavior:

- macOS builds `media/native/libportmanager_hook.dylib` and `media/native/portmanager_asdf_shim`.
- macOS signs both artifacts with ad-hoc codesigning through `codesign --force --sign -` when `codesign` is available.
- Linux builds `media/native/libportmanager_hook.so`.
- If `cc` is missing, the script skips native hook compilation. Treat that as a release blocker when the release is expected to ship hook support for that platform.
- Unsupported platforms skip the native hook build. The extension can still package, but hooked terminal routing is unavailable for those platforms.

For a macOS release build, confirm the generated files exist after packaging and inspect signatures when needed:

```sh
codesign --verify --verbose media/native/libportmanager_hook.dylib
codesign --verify --verbose media/native/portmanager_asdf_shim
```

## Build, Test, And Package

Install dependencies once for the release checkout:

```sh
npm install
```

Run the full release precheck before publishing:

```sh
npm run publish:precheck
```

This runs:

- TypeScript compile through `npm test`
- native hook build through `vscode:prepublish` during VSIX packaging
- unit tests through Node's test runner
- VSIX packaging through `vsce package`

The package command produces a file such as:

```text
portmanager-0.0.1.vsix
```

If you only need to rebuild the VSIX after a successful test run:

```sh
npm run package
```

## VSIX Install Verification

Install the generated VSIX before publishing:

```sh
code --install-extension portmanager-0.0.1.vsix --force
```

For a cleaner manual check, install into temporary VS Code profile directories:

```sh
code --user-data-dir /tmp/portmanager-vsix-user --extensions-dir /tmp/portmanager-vsix-ext --install-extension portmanager-0.0.1.vsix --force
code --user-data-dir /tmp/portmanager-vsix-user --extensions-dir /tmp/portmanager-vsix-ext
```

Verify in the Extension Development Host or clean profile:

- The installed extension ID is `newdlops.portmanager`.
- The Port Manager activity bar view appears.
- Logical network creation, terminal refresh, and host port exposure commands are present.
- The README, changelog, settings, command list, and Marketplace icon render correctly in the extension details page.
- On supported platforms, the native hook artifacts are present under the installed extension's `media/native` directory.

## Publish

Publish only after the precheck and local VSIX install verification pass.

```sh
npm run publish
```

Equivalent direct command:

```sh
npx vsce publish
```

For a package that was already verified and should be uploaded unchanged, publish that exact VSIX:

```sh
npx vsce publish --packagePath portmanager-0.0.1.vsix
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

Example patch release:

```sh
npx vsce publish patch
```

When using `vsce publish patch`, confirm the generated version and changelog entry before the command completes the release. For stricter release control, update `package.json` and `CHANGELOG.md` in a separate commit, run `npm run publish:precheck`, verify the VSIX, then publish with `npx vsce publish --packagePath`.

## Token Handling

Do not commit Marketplace tokens or paste them into tracked files. For long-term automated publishing, prefer Microsoft Entra ID based automation over long-lived PAT storage. Personal access tokens should be treated as secrets and kept out of the repository.
