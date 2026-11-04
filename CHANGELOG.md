# Changelog

All notable changes to `dsh-repo-push` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-11-04

### Added

- TypeScript declarations (`lib/index.d.ts`, `types` field) for the plugin config,
  the `repo_push` arguments and its result.
- GitHub Actions workflow running the test suite on Node 20/22, Linux and Windows.
- `SECURITY.md` describing the package's capabilities and the threat model.
- README "Security" section pointing at the above.

## [0.2.0] — 2026-11-04

### Added

- `patterns` (glob allowlist), `~` expansion and workspace-relative `repos` entries.
- `sync` (`none` / `ff-only` / `rebase`): fetch and align with the remote before pushing.
- `allowDefaultRepo` (default off): `repo` is required unless explicitly enabled.
- Committing deletions: paths already removed from the work tree are accepted when
  the index records the deletion.

### Changed

- Renamed from `dsh-docs-push`; the tool is `repo_push`.
- A failing `fetch` no longer blocks the push; it is reported in `detail` and the
  push still runs. A rebase conflict aborts and leaves the repository untouched.

## [0.1.0]

- Initial implementation: whitelisted repository roots, explicit-path commits and a
  host-process push that works under the Windows `workspace-write` sandbox.
