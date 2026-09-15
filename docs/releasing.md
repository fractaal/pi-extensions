# Releasing Pi extensions

Each workspace remains a separate npm package with its own version. Releases use the existing [GitHub Actions workflow](../.github/workflows/publish-npm.yml); do not publish existing packages from a local npm login or token.

## Package contract

- `packages/<directory>/package.json` names `@fractaal/pi-<directory>` and declares `publishConfig.access: public`.
- Preserve existing npm names, exports, Pi entrypoints, and runtime contracts during source moves. Consolidation does not require lockstep versions or a combined installation bundle.
- `pi.extensions` identifies a shipped Pi loader entry; programmatic exports identify built JavaScript and declarations. Most packages ship `src/` and `dist/`; Claude Bridge retains its bundle and isolated-runtime exports.
- `prepack` builds the package. Generated artifacts are ignored by Git, included in the npm tarball, and verified before release.
- Repository metadata points to this repository and the package's `repository.directory`. Preserve package licenses and upstream attribution.
- Declare host Pi packages as peers and actual third-party runtime dependencies as dependencies. Do not broaden compatibility or alter a package's minimum supported host just to unify manifests.
- The root typecheck runs shared checks and workspace `typecheck` scripts. The root Vitest suite discovers `packages/**/tests/**/*.test.ts`, excluding the Goal-family Node suite, which runs explicitly via its workspace `test` script. `lint` retains the Goal-family lint gate; `test:installed` runs all workspace acceptance scripts when present. Goal-family acceptance covers Goal, Todo, and context-window together, packing and installing each independently.

## Trusted Publisher: configure per package

Before publishing a package here, inspect its npm **Access** page and configure/verify:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization or user | `fractaal` |
| Repository | `pi-extensions` |
| Workflow filename, without its path | `publish-npm.yml` |
| Environment name | `npm-publish` |
| Allowed action | `npm publish` |

A source-repository move does not automatically update npm's trusted publisher. Existing packages do not need to be recreated or bootstrapped. A genuinely new package's first publication is a separate approval/setup step; do not fall back to local publishing when an existing package's OIDC configuration fails.

The GitHub `npm-publish` environment must admit package release tags (`*-v*`), and matching tags must be protected against update/deletion. The publication job grants `contents: read` and `id-token: write`, uses an OIDC-capable npm, and needs no npm token or OTP secret. Preserve established npm account/2FA policy.

## Prepare and publish

1. Change the selected package's version to a new SemVer, update the workspace lockfile, and merge the reviewed source to `main`.
2. Verify from that exact accepted source:

   ```bash
   npm ci
   npm run typecheck
   npm run lint
   npm test
   npm run build
   npm run test:installed
   npm pack --dry-run --workspace @fractaal/pi-cross-agent-memory
   ```

   The last command is an example; select the package being released. Tests/builds from a different commit are not release-artifact evidence.
3. Confirm the package's Trusted Publisher tuple above, then create an immutable tag at the accepted release commit:

   ```bash
   git tag cross-agent-memory-v0.3.1 <accepted-release-commit>
   git push origin cross-agent-memory-v0.3.1
   ```

   The general format is `<package-directory>-v<manifest-version>`. Creating/pushing the tag starts publication; it is not a dry run.
4. Watch the workflow. It verifies the live tag, version, and ancestry in `main`; runs tests/typechecks/lint; builds/packs the selected package; runs all installed-package acceptance (including shared sibling coverage); revalidates the refs; and publishes with provenance.
5. Verify the exact registry version:

   ```bash
   npm view @fractaal/pi-cross-agent-memory@0.3.1 version gitHead dist.integrity dist.attestations --json
   ```

   Check that `gitHead` is the release commit and that provenance/attestations exist. A successful build is not proof of a successful publication.

Rerun the same workflow/tag after a failure; never move a published version or its tag. The workflow skips an existing version only when its registry `gitHead` matches the release commit.

## Batch releases

One reviewed commit can contain several independent package version bumps. After every affected npm Trusted Publisher is verified, create each package tag at that same accepted commit. Push at most three tags per push; GitHub suppresses tag events when more than three are pushed together:

```bash
# Replace this with the exact merged, verified commit.
commit=<accepted-release-commit>
git tag cross-agent-memory-v0.3.1 "$commit"
git tag goal-x-v0.28.9 "$commit"
git tag todo-v0.1.3 "$commit"
git tag context-window-v0.1.1 "$commit"
git push --atomic origin \
  cross-agent-memory-v0.3.1 goal-x-v0.28.9 todo-v0.1.3
git push origin context-window-v0.1.1
```

GitHub starts the existing per-package publication workflow for each tag. The first three Git tags are pushed atomically, then the fourth starts immediately as part of the same release batch. This follows [GitHub's three-tag event limit](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push); **the complete batch and npm publication are not atomic**. Verify every result; if a job fails, repair its configuration and rerun that same immutable tag. Do not change versions or fall back to a local publisher to recover a partial batch.

## Migrated packages and consumers

Publish a **new** version from this repository. Old npm versions and old Git refs keep their original source identity. Preserve those refs for existing installations.

Pinned npm consumers do not automatically upgrade. Update consumer versions deliberately after the replacement release is verified. If replacing a Git installation with npm, remove the old active source rather than loading the same extension twice. Update any installer that recreates the old Git source.

Add a migration notice and retire the old release path after the replacement is verified. Do not delete/archive the old repository or publish private source/history as an implicit part of a folder move.
