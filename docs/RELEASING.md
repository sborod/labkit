# Installation and releases

## Version policy

The version in package.json and package-lock.json is the SDK package version
(SemVer). Git tags are exactly `vMAJOR.MINOR.PATCH`. While the SDK is on 0.x,
patch releases preserve compatibility; incompatible public API changes require
a new minor version and migration notes. Compatible features may also use a new
minor version. After 1.0, normal SemVer major/minor/patch rules apply.
Do not move a released tag or replace its archive; publish a new patch instead.
The first publicly available release is v0.1.1. Use published release URLs or valid Git tags.

`CONTRACT_VERSION` (currently `"0.1"`) describes the runtime definition contract,
not the package build. Change it only when the contract is incompatible.
Applications should import this constant from their installed SDK.

## Consumer installation

LabKit is hosted in a public GitHub repository. HTTPS Git installation requires
no deploy key, token or GitHub login. Do not commit credentials.

### Alternative: Git tag

From the lab root:

```sh
npm install --save-exact 'git+https://github.com/sborod/labkit.git#v0.1.1'
```

npm resolves the tag to a commit
in the lockfile and builds the package using its prepare lifecycle. The same
hook builds the SDK on npm ci in the SDK repository.
Use the SDK's declared Node version and allow dependency build scripts.
Commit package.json and package-lock.json; subsequent installs use `npm ci`.
A full commit SHA can be used instead of a tag when testing an unreleased change.

Public HTTPS works for both private and public consumer repositories in CI;
no cross-repository secret is required.

### Recommended: prebuilt GitHub Release archive

Install the public release directly from the lab root:

```sh
npm install --save-exact https://github.com/sborod/labkit/releases/download/v0.1.1/labkit-0.1.1.tgz
```

Commit both npm manifests. npm records the archive URL and integrity hash.
For a separate local copy and explicit SHA-256 verification:

```sh
mkdir -p vendor
curl -fL -o vendor/labkit-0.1.1.tgz https://github.com/sborod/labkit/releases/download/v0.1.1/labkit-0.1.1.tgz
curl -fL -o vendor/labkit-0.1.1.tgz.sha256 https://github.com/sborod/labkit/releases/download/v0.1.1/labkit-0.1.1.tgz.sha256
(cd vendor && sha256sum -c labkit-0.1.1.tgz.sha256)
npm install --save-exact ./vendor/labkit-0.1.1.tgz
```

On macOS use `shasum -a 256 -c` instead. Commit the lockfile and either the archive or arrange for the same archive
to be fetched into vendor before npm ci.
This route needs no SDK build or SDK development dependencies in the consumer.

### Local SDK development

Keep the existing `file:../../labkit` setup for unpublished labs if desired.
Build LabKit after changes. For a release-pinned lab, test a local build without
rewriting its tracked dependency/lockfile:

```sh
# In labkit
npm ci
# Rebuild with npm run build after edits.
# In the lab (adjust path)
npm install --no-save --package-lock=false ../../labkit
```

Restore the locked dependency with npm ci. Do not commit local-only paths to a
release-pinned lab.

## Release procedure

1. Update CHANGELOG.md with the changes and compatibility notes.
2. Run `npm version patch --no-git-tag-version` (or minor/major),
   which updates both manifests; commit them and the changelog in a PR.
3. Merge the verified PR into main.
4. A successful main CI run publishes the version if it has no existing release.
   It creates the matching tag on the verified commit and uploads the tested
   archive plus SHA-256 checksum. Existing releases are never replaced.
   Manual workflow dispatch on main is also supported.

An existing matching tag can be pushed manually from main if desired. The
tag must identify the verified commit; a conflicting tag is rejected. The
workflow validates both manifests, runs all checks, packs the SDK, and tests
fresh consumer installs from both the archive and Git. No npm registry
credentials are required. If a tagged version needs a code change, publish
a new version rather than moving the tag.

See [development and verification](DEVELOPMENT.md) for quality and documentation policy.
