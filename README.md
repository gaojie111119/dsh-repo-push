# dsh-repo-push

A [DSH](https://github.com/deepseek-ai/deepseek-harness) host plugin that lets an agent **commit and push a git repository** from the host process while the session stays
in `workspace-write` mode. It registers a single native tool, `repo_push`. Typical use: docs and knowledge-base
repositories that an agent maintains on its own.

[中文说明](README.zh.md)

## Why this exists

On Windows the DSH sandbox runs commands under a restricted token (low integrity, write-restricted SIDs). A
restricted process **cannot spawn a child with piped stdio** — the named-pipe client end is not granted to the
restricting SIDs. Git's entire remote transport (`ssh.exe`, `git-remote-https`, `git-receive-pack`) is built on
piped child processes, so every network operation fails:

```
error: cannot create standard input pipe for ...\System32\OpenSSH\ssh.exe: Permission denied
fatal: unable to fork
```

It is not an SSH problem — switching to `https://` reports `cannot create standard input pipe for remote-https`.
Local `git add` / `git commit` are unaffected; only fetching from or pushing to a remote breaks.

This plugin moves `add → commit → push` into the DSH **host process** (the same process that already spawns MCP
servers and native workers), so the session keeps its sandbox and pushes need no approval.

## Install

```bash
dsh plugin --profile <profile> add dsh-repo-push
```

Development against a local checkout:

```bash
dsh plugin --profile <profile> add "$DSH_HOME/tools/dsh-repo-push"
# linked ESM modules are not hot-reloaded: toggle the row (or restart DSH) after editing lib/*
```

The plugin is a bundle patch that inserts one row (`id: repo-push`).

## Configure

```yaml
- id: repo-push
  name: dsh-repo-push
  config:
    repos:
      - /home/me/notes          # or C:/Users/me/docs
      - /home/me/handbook
    defaultRepo: /home/me/notes
    remote: origin
    allowPush: true
    timeoutMs: 120000
    gitPath: git
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `repos` | `string[]` | `[]` | Allowlist of repository roots. Absolute paths are used as-is; **relative paths resolve against the session workspace**, and a relative entry only counts when that subdirectory exists. `~` expands to the home directory. Empty means only the current session workspace. Anything not listed is refused. |
| `patterns` | `string[]` | `[]` | Glob patterns that also authorize a repository root (see below). Relative patterns match the path relative to the session workspace; absolute patterns match the absolute path. **Authorization only** — a pattern never picks the default repo. |
| `defaultRepo` | `string` | `""` | Repository used when a call omits `repo` — only meaningful with `allowDefaultRepo: true`. |
| `remote` | `string` | `origin` | Remote to push to. It must already exist. |
| `sync` | `'none' \| 'ff-only' \| 'rebase'` | `'ff-only'` | What to do before pushing: fetch, then integrate remote commits (see below). |
| `allowPush` | `boolean` | `true` | Set to `false` for a commit-only deployment. |
| `allowDefaultRepo` | `boolean` | `false` | When `false`, every call must name its `repo`. Set to `true` to let calls fall back to `defaultRepo` / the workspace root. |
| `timeoutMs` | `number` | `120000` | Per-git-command timeout. |
| `gitPath` | `string` | `git` | Path or command name for the git executable. |

Invalid configuration never breaks host startup: the plugin still loads, and every call returns
`invalid-config` with the specific complaints.

### The allowlist is the security boundary

`repos` is the only thing that stops the tool from pushing somewhere you did not intend — **anything not listed is
refused**. A call's `repo` (or the resolved default) is checked with symlinks and must land inside one of the
configured roots; anything else fails with `invalid-args`. Keep it narrow.

### One config, several workspaces

Relative entries resolve against the session workspace on every call, and **a relative entry only counts when that
subdirectory exists in the current workspace**. That handles layouts where each workspace keeps its docs repo in a
different place:

```yaml
repos:
  - docs/team-notes   # workspaces that keep it under docs/
  - team-notes        # workspace that keeps it at the top level
```

When `allowDefaultRepo: true`, a call may omit `repo` and the tool resolves in this order: `defaultRepo` → the
**only** usable root → the root containing the session workspace. With the default `allowDefaultRepo: false`, a call
without `repo` is refused — the tool never picks a repository on its own. Even when enabled, several remaining roots
that cannot be tied to the workspace make the call fail rather than guess.

> Two checkouts of the same repository (e.g. the same docs repo checked out in two workspaces) are both pushable if
> both are listed. Push from one checkout and `pull` in the other; concurrent edits will diverge.

### Matching by directory name

When several workspaces keep their docs repo in differently named directories, a pattern saves one entry per
workspace:

```yaml
repos:
  - docs/team-notes  # gives omitted-`repo` calls a default (needs allowDefaultRepo: true)
  - team-notes
  - project-notes
  - ~/.dsh
patterns:
  - '**/*-notes'     # authorizes any workspace's *-notes repo
```

`**` crosses directory separators, `*` and `?` do not. A relative pattern is matched against the repository path
**relative to the session workspace**, so it cannot reach outside it; an absolute pattern matches the absolute path.

Two things patterns deliberately do not do:

- **They never choose the default repository.** `repo_push({})` still needs a concrete root, from `repos` /
  `defaultRepo`. With `patterns` alone, always pass `repo`.
- **They do not fall back to the workspace.** Configuring `patterns` without `repos` means "only matching
  repositories", not "the whole workspace" — so a workspace root repository stays refused.

Keep patterns tight: `**/*-notes` also matches `old-notes`.

## Use

`repo` is required unless `allowDefaultRepo: true` is configured.

```
repo_push({ repo: ".", paths: ["skills/a.md", "README.md"], message: "docs: update" })  # commit + push
repo_push({ repo: "." })                                                              # push existing commits only
repo_push({ repo: "notes", paths: ["daily/2026-11-04.md"], message: "..." })           # another repo
repo_push({ repo: ".", paths: ["x.md"], message: "...", push: false })                 # commit only
```

`paths` are **relative to the repository root** and are validated one by one; absolute paths and `..` escapes are
rejected. Commit messages travel on stdin, so multi-line and non-ASCII messages are safe. Only those paths are
committed — the tool never touches work another person staged.

Returns:

```json
{
  "ok": true,
  "action": "committed-and-pushed",
  "repo": "/path/to/repo",
  "branch": "main",
  "commit": "<sha>",
  "pushed": true,
  "upToDate": false,
  "code": "ok",
  "detail": "abc1234..def5678  main -> main",
  "output": "..."
}
```

`action` is one of `committed-and-pushed`, `pushed`, `committed`, `nothing-to-do`, `sync-failed`,
`commit-failed-sync`, `push-failed`, `commit-failed-push`, `failed`.

### Staying in sync before pushing

The sandbox cannot run `git pull` either — same pipe restriction — so the tool does the fetch itself:

| `sync` | Behaviour |
| --- | --- |
| `ff-only` (default) | `git fetch`, then fast-forward merge **only if** the local branch has no commits the remote lacks. Diverged → `non-fast-forward`, nothing rewritten. |
| `rebase` | `git fetch`, then replay local commits on top of the remote (`--autostash`, so a dirty worktree works too). A conflict aborts the rebase and leaves the repository exactly as it was. |
| `none` | Push straight away; a diverged branch fails with `non-fast-forward`. |

Only commits that have not been pushed yet are ever rewritten, and only in `rebase` mode. The tool never force-pushes.

A fetch timeout or network hiccup never blocks the push: the sync is skipped, the result says so, and the push is
still attempted. Only conditions that need a human (a rebase conflict) abort.

### Failure codes

| Code | Meaning / next step |
| --- | --- |
| `auth` | SSH or HTTPS credentials rejected. Fix the credential, do not retry blindly. |
| `network` | DNS / connection failure or proxy problem. |
| `non-fast-forward` | Remote has commits you do not have. Use `sync: rebase`, or `pull --rebase`, then retry. Force-push is never used. |
| `rebase-conflict` | `sync: rebase` hit a conflict; the rebase was aborted and the repository is unchanged. Resolve by hand. |
| `not-a-repo` / `detached-head` | Path is not a git work tree, or HEAD is detached. |
| `path-not-matched` | A `paths` entry does not exist in the work tree. |
| `timeout` | `timeoutMs` elapsed; check network or push size. |
| `invalid-args` / `invalid-config` | Call or plugin configuration is wrong; nothing was executed. |

## Security model

- The tool runs git in the host process **by design** — that is what escapes the pipe restriction. Treat the
  allowlist as a privilege boundary: an agent can push any content to an allowlisted repository.
- Only `git add -- <paths>`, `git commit -F - -- <paths>` and `git push <remote> <branch>` are executed. No force
  push, no remote rewriting, no arbitrary shell.
- Credentials are the current user's (`~/.ssh` or a credential helper); the agent key should be passphrase-less,
  since the host cannot prompt interactively.

## Security

The package spawns `git` in the host process (that is the whole point), reads and writes
files in the allowlisted repositories, and reaches the network with your credentials. It has
zero runtime dependencies and no install scripts. The allowlist is the security boundary.

Details, threat model and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Platform support

| Platform | Sandbox | `git push` inside the sandbox | This plugin |
| --- | --- | --- | --- |
| Windows | restricted token (low integrity, write-restricted SIDs) | **blocked** — the token cannot create piped stdio for child processes (`cannot create standard input pipe` / `unable to fork`) | required |
| Linux | bubblewrap / Landlock | works | optional |
| macOS | Seatbelt (`sandbox-exec`) | works | optional |

The POSIX backends restrict **filesystem writes**; they do not stop a process from spawning a child with
pipes, so git's transports work normally there. The plugin still runs fine everywhere (it just executes git in
the host), so leaving it enabled is harmless — it is only *required* on Windows.

CI runs the test suite on Linux and Windows, Node 20 and 22.

## Development

```bash
npm test        # node test/run.mjs — zero-dependency, single process (no child spawn)
```

The test harness is a plain script on purpose: `node --test` spawns a child per file, which is exactly what a
restricted sandbox refuses.

## License

MIT
