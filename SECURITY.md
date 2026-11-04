# Security policy

## What this package does

`dsh-repo-push` is a DSH host plugin that runs `git` **in the DSH host process** so that an
agent can commit and push while the session stays inside the Windows `workspace-write`
sandbox. The sandbox blocks piped child processes, so `git push` cannot work there; this
plugin is the escape hatch, deliberately.

Consequences you should know before installing it:

- It spawns `git` (`fetch`, `add`, `commit`, `merge`, `rebase`, `push`) as child processes of
  the host, with the host user's credentials.
- It reads and writes files inside the repositories you allowlist.
- It reaches the network through git (SSH or HTTPS), using the host user's ssh keys or
  credential helper.
- It has **zero runtime dependencies** and no install scripts.

## Threat model

The allowlist (`repos` + `patterns`) is the security boundary: a repository that is not
listed is refused. An agent with tool access can therefore push arbitrary content **to the
allowlisted repositories** — that is the intended capability, and the reason you should
allowlist documentation/knowledge repositories rather than code you would not let an agent
modify.

The plugin never force-pushes, never rewrites remotes or git config, and only runs the fixed
subcommands listed above with argument arrays (no shell interpolation).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on
<https://github.com/gaojie111119/dsh-repo-push/security/advisories/new>, or open an issue that
does not disclose the details. Reports are usually acknowledged within a few days.

## Supported versions

The latest published minor version receives fixes; there is no backport branch for older
releases.
