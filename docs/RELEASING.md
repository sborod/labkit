# Installation and releases

## Version policy

The version in package.json and package-lock.json is the SDK package version
(SemVer). Git tags are exactly `vMAJOR.MINOR.PATCH`. While the SDK is on 0.x,
patch releases preserve compatibility; incompatible public API changes require
a new minor version and migration notes. Compatible features may also use a new
minor version. After 1.0, normal SemVer major/minor/patch rules apply.
Do not move a released tag or replace its archive; publish a new patch instead.

`CONTRACT_VERSION` (currently `"0.1"`) describes the runtime definition contract,
not the package build. Change it only when the contract is incompatible.
Applications should import this constant from their installed SDK.

## Consumer installation

LabKit's repository is private. GitHub authentication is required; do not put
tokens in package.json, package-lock.json, or Git URLs committed to a repository.

### Recommended: Git tag

With a GitHub SSH key authorized to read LabKit:

```sh
npm install --save-exact 'git+ssh://git@github.com/sborod/labkit.git#v0.1.0'
```

Or use an authenticated HTTPS Git credential helper and
`git+https://github.com/sborod/labkit.git#v0.1.0`. npm resolves the tag to a commit
in the lockfile and builds the package using its prepare lifecycle. The same
hook builds the SDK on npm ci in the SDK repository.
Use the SDK's declared Node version and allow dependency build scripts.
Commit package.json and package-lock.json; subsequent installs use `npm ci`.
A full commit SHA can be used instead of a tag when testing an unreleased change.

For private cross-repository CI, configure a read-only deploy key for LabKit or
a narrowly scoped GitHub App/token via a credential helper. The consumer repo's
default GITHUB_TOKEN does not grant access to LabKit. Keep credentials out of logs.
Use the same Git transport locally and in CI.

### Alternative: prebuilt GitHub Release archive

With authenticated GitHub CLI, from the lab root:

```sh
mkdir -p vendor
gh release download v0.1.0 --repo sborod/labkit --pattern 'labkit-0.1.0.tgz*' --dir vendor
(cd vendor && sha256sum -c labkit-0.1.0.tgz.sha256)
npm install --save-exact ./vendor/labkit-0.1.0.tgz
```

On macOS use `shasum -a 256 -c` instead. Commit the lockfile and either the archive
(if your lab repository may contain the SDK) or arrange for the same archive
to be fetched into vendor before npm ci. Do not commit a private SDK archive to
a public lab. Direct unauthenticated release URLs do not work for private repos.
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
