# Changelog

All notable changes to `dsh-repo-push` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] — 2026-11-23

### Added

- `remotes` config (`string[]`, default `['origin']`): the allowlist of remote names a call may
  target. Names must match `^[A-Za-z0-9._-]+$`; blank entries are dropped, duplicates removed, and
  invalid names are reported by config validation.
- `repo_push` accepts `remote` (defaults to `config.remote`) and `mirror` (default `false`).
  `remote` must be listed in `remotes`; otherwise the call fails with `invalid-args`.
- Mirror mode: `git push <remote> --all`, then `git push <remote> --tags`, stopping at the first
  failure. It does not commit, fetch or rebase, and returns `action: "mirrored"` with `remote` and
  `pushed: true`.
- Tests for the default remote, remote allowlisting, mirror command order and failure stop, mirror
  argument conflicts, and the tool-level `invalid-args` wiring.

### Changed

- `synchronize` and `pushBranch` use the selected remote instead of the global `config.remote`;
  with the default configuration the executed commands are unchanged.

### Breaking changes and migration

- `remote` must be listed in `remotes`. A deployment that set `remote` to a non-`origin` name and
  has no `remotes` now reports `invalid-config`; add the name, e.g. `remotes: [github]`.
- In mirror mode `paths`, `message`, `branch` and `push: false` are rejected with `invalid-args`.
  `branch` is rejected rather than ignored because `--all` always pushes every branch: accepting a
  branch would imply a narrowing git cannot perform, and silently ignoring it would hide the
  mismatch. `--mirror` is deliberately not used because it deletes refs that exist only on the
  mirror.

## [0.2.1] — 2026-11-04

### Added

- TypeScript declarations (`lib/index.d.ts`, `types` field) for the plugin config,
  the `repo_push` arguments and its result.
- GitHub Actions workflow running the test suite on Node 20/22, Linux and Windows.
- `SECURITY.md` describing the package's capabilities and the threat model.
- README "Security" section pointing at the above.
- README "Platform support" table: the plugin is *required* only on Windows; Linux/macOS
  sandboxes (bubblewrap/Landlock/Seatbelt) do not block git's child pipes.
- Tests are platform-neutral: absolute paths are built with `path.resolve` instead of
  relying on Windows drive-letter literals, so the suite also passes on Linux CI.

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
