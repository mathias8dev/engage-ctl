# Reviewed semantic releases

`develop` is the integration branch and `master` the production/stable branch.
The authoritative native version file(s) are `package.json`.
`.release.json` records only their locations; it does not duplicate a version.
For repositories without package metadata, `VERSION` is the sole version source.
No release framework or registry service is required. The local script requires
Git and Python 3.11+; mise pins Python when it owns the project commands.

## Prepare and review

Start with a clean checkout. Preparation defaults to local develop HEAD, fetches
origin when configured, and rejects a default develop behind/diverged from its
remote. `--from` accepts a commit in develop history and excludes subsequent work.
The selected snapshot must contain this release tooling and production fixes.
Offline/local-only repositories can use `--no-fetch` with existing references.

```sh
mise run release:prepare --dry-run
mise run release:prepare
mise run release:prepare --from DEVELOP_COMMIT --bump minor
mise run release:check --branch release/X.Y.Z
```

Use one actual preparation after reviewing the dry run. It creates and checks out
`release/X.Y.Z`, updates the native versions and related owned lock metadata, and
drafts a dated `CHANGELOG.md` entry. Existing Unreleased notes move into the new
entry. It never commits, pushes, opens an MR, tags, publishes or deploys.
Dry run leaves the branch/files unchanged, but may fetch remote references.

Conventional Commits propose the highest impact since the highest stable tag
reachable from master: `!` or `BREAKING CHANGE:`/`BREAKING-CHANGE:` means major,
`feat:` means minor, otherwise patch. Existing tags with/without `v` and legacy
build metadata remain readable. Without a release tag, the declared native
version is the baseline and all selected history is reviewed. Preparation never
proposes a version below the current manifest. A numeric Flutter build suffix
increments independently. The current version and historical notes do not by
themselves establish a successful production delivery.

Review compatibility, migrations and generated notes; commit-message analysis
cannot prove compatibility. `--bump major|minor|patch` explicitly overrides the
proposal. Commit the reviewed files and run the release check before opening the
MR. The check reads committed content; uncommitted edits are not an approval.
Run the repository's existing practical checks and validate preproduction where
applicable. After approval, merge the same branch into master and develop with
`--no-ff`. Keep it until both merges and successful delivery, then remove it.

## Delivery

Delivery takes this exact reviewed native version. Never allocate a new number
after review or merely to retry a failed publication. Applications tag the exact
deployed commit only after successful production readiness. Package repositories
retain their explicitly authorized tag/publication gates and native-platform
verification; a package tag must match the reviewed version and stable source.
Successfully published tags, package versions and image aliases are immutable.
No push, release, deployment or external settings change is implied by setup.

Master merging and application deployment remain separate operations: until the
deployment succeeds, master can be ahead of production. Use the deployment
receipt and immutable tag to identify what was actually delivered.

The release script is synchronized verbatim from
`mathias-engineering/scripts/release.py`. Its behavior tests live in that
repository. It never imports a sibling checkout at runtime.
