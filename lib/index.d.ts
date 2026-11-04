// Type declarations for dsh-repo-push.
//
// The runtime module is plain ESM JavaScript (see lib/index.js); this file only
// describes the plugin shape and the tool payloads so TypeScript consumers and
// editors get help without a build step.

/** Plugin configuration (the `config:` block of the `repo-push` row). */
export interface RepoPushConfig {
  /** Allowlisted repository roots. Absolute paths are used as-is; relative ones resolve against the session workspace and only count when the directory exists. `~` expands to the home directory. Empty means "the session workspace only". */
  repos?: string[]
  /** Glob patterns that also authorize a repository root. Relative patterns match the workspace-relative path, absolute ones the absolute path. Authorization only — never picks the default repository. */
  patterns?: string[]
  /** Repository used when a call omits `repo`; only honored with `allowDefaultRepo: true`. */
  defaultRepo?: string
  /** Remote name to push to. Must already exist in the repository. Default `origin`. */
  remote?: string
  /** Pre-push alignment with the remote: fetch, then integrate. Default `ff-only`. */
  sync?: 'none' | 'ff-only' | 'rebase'
  /** Set to `false` for a commit-only deployment. Default `true`. */
  allowPush?: boolean
  /** When `false` (default) every call must name its `repo`. */
  allowDefaultRepo?: boolean
  /** Per-git-command timeout in milliseconds. Default `120000`. */
  timeoutMs?: number
  /** git executable path or command name. Default `git`. */
  gitPath?: string
}

/** Arguments accepted by the `repo_push` tool. */
export interface RepoPushArgs {
  /** Repository path: absolute, or relative to the session workspace. Required unless `allowDefaultRepo` is on. */
  repo?: string
  /** Commit message. Required when `paths` is given. */
  message?: string
  /** Explicit paths to commit, relative to the repository root. Omit to only push existing commits. */
  paths?: string[]
  /** Push to the remote. Default `true`. */
  push?: boolean
  /** Branch to push. Defaults to the current branch. */
  branch?: string
}

/** Terminal state of one `repo_push` call. */
export type RepoPushAction =
  | 'committed-and-pushed'
  | 'pushed'
  | 'committed'
  | 'nothing-to-do'
  | 'sync-failed'
  | 'commit-failed-sync'
  | 'push-failed'
  | 'commit-failed-push'
  | 'failed'

/** Stable failure codes returned in `code`. */
export type RepoPushFailureCode =
  | 'ok'
  | 'auth'
  | 'network'
  | 'non-fast-forward'
  | 'rebase-conflict'
  | 'not-a-repo'
  | 'detached-head'
  | 'path-not-matched'
  | 'timeout'
  | 'spawn-failed'
  | 'git-failed'
  | 'invalid-args'
  | 'invalid-config'

/** Result payload of one `repo_push` call. */
export interface RepoPushResult {
  ok: boolean
  action: RepoPushAction
  repo: string
  branch: string
  /** HEAD after the call; empty when nothing was committed. */
  commit: string
  pushed: boolean
  upToDate: boolean
  code: RepoPushFailureCode | (string & {})
  detail: string
  /** Tail of the git output, for diagnosis. */
  output: string
}

/** The minimal slice of the Cordis context this plugin uses. */
export interface PluginContextLike {
  tools: {
    register(definition: {
      name: string
      description: string
      parameters: Record<string, unknown>
      output: { schema: Record<string, unknown>; render: (args: RepoPushArgs, value: RepoPushResult) => unknown }
      execute: (args: RepoPushArgs, exec?: unknown) => Promise<RepoPushResult>
      isConcurrencySafe: () => boolean
    }): void
  }
}

export declare const name: 'dsh-repo-push'
export declare const inject: readonly ['tools']
export declare function apply(ctx: PluginContextLike, config?: RepoPushConfig): void
