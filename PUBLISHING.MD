# Publishing Port Manager

This document describes the first Marketplace publish flow for `newdlops.portmanager`.

## Publisher

- Publisher ID: `newdlops`
- Extension name: `portmanager`
- Marketplace extension ID: `newdlops.portmanager`
- Repository: `https://github.com/newdlops/portmanager`
- Initial version: `0.0.1`
- Release channel: preview

The publisher ID in `package.json` must match the publisher created in Visual Studio Marketplace.
If the GitHub repository uses a different URL, update `repository`, `bugs`, and `homepage` in `package.json` before publishing.

## Local Precheck

Run the full local precheck before packaging or publishing.

```sh
npm install
npm run publish:precheck
```

This runs:

- TypeScript compile
- unit tests
- VSIX packaging through `vsce package`

## First Login

For an interactive first publish, create or verify the Marketplace publisher named `newdlops`, then log in with `vsce`.

```sh
npx vsce login newdlops
```

Do not commit tokens or paste them into tracked files.

## Package Only

Create a local VSIX for manual testing or manual Marketplace upload.

```sh
npm run package
```

The command produces a file like:

```text
portmanager-0.0.1.vsix
```

Install it locally with:

```sh
code --install-extension portmanager-0.0.1.vsix
```

## Publish

After login and precheck, publish the current version.

```sh
npm run publish
```

For the first release, verify the Marketplace page after publishing:

- display name is `Port Manager`
- publisher is `newdlops`
- README renders correctly
- command list and settings appear
- extension installs in a clean VS Code profile

## Versioning

Update `CHANGELOG.md` before every publish.

Use SemVer for `package.json`:

- `0.0.x`: preview fixes
- `0.x.0`: preview feature additions
- `1.0.0`: stable release

Example patch release:

```sh
npx vsce publish patch
```

## Authentication Note

VS Code Marketplace publishing supports `vsce publish` with a Marketplace publisher identity. For long-term automated publishing, prefer Microsoft Entra ID based automation over long-lived PAT storage. Personal access tokens should be treated as secrets and kept out of the repository.
