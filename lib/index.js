// DSH 宿主插件：在宿主进程里完成「显式路径 add → commit → push」。
//
// 背景：Windows 的 workspace-write 沙箱拒绝受限进程为子进程创建管道 stdio，
// 而 git 的远端传输（ssh / git-remote-https / receive-pack）全部依赖管道，
// 所以沙箱内 `git push/fetch/pull` 必然失败。本插件把这一步搬到宿主进程，
// 会话仍然保持 workspace-write，只放开「往白名单仓库推送」这一个动作。

import fs from 'node:fs'
import path from 'node:path'
import {
  assertAllowed,
  normalizeConfig,
  realOrResolved,
  resolveRemote,
  resolveRepo,
  validatePaths,
} from './config.js'
import { classifyFailure, describeFailure, git } from './git.js'
import { assertMirrorArgs, failure, mirrorPush, pushBranch, synchronize } from './push.js'

export const name = 'dsh-repo-push'

export const inject = ['tools']

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    repo: {
      type: 'string',
      description: '仓库路径（绝对，或相对会话工作区）；默认必填。',
    },
    message: {
      type: 'string',
      description: '提交信息；给 paths 时必填。',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: '要提交的路径（相对仓库根）；省略则只推送。',
    },
    push: {
      type: 'boolean',
      description: '是否推送到远端，默认 true。',
    },
    branch: {
      type: 'string',
      description: '推送的分支，默认当前分支。',
    },
    remote: {
      type: 'string',
      description: '远端名，默认配置里的 remote；必须在 remotes 中。',
    },
    mirror: {
      type: 'boolean',
      description: '镜像全部分支与标签（不提交、不 fetch），默认 false。',
    },
  },
}

const OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    repo: { type: 'string' },
    branch: { type: 'string' },
    remote: { type: 'string' },
    commit: { type: 'string' },
    pushed: { type: 'boolean' },
    upToDate: { type: 'boolean' },
    code: { type: 'string' },
    detail: { type: 'string' },
    output: { type: 'string' },
  },
  required: ['ok', 'action'],
}

// 工具描述会原样进入每个会话的系统提示词（Program-only SDK bindings 段），
// 只留“是什么 + 调用要点”；sync、白名单与错误码见 README.md。
const DESCRIPTION =
  '提交并推送 git 仓库（宿主进程执行，不受 Windows 沙箱管道限制）。repo 默认必填；给 paths 即提交，省略 paths 只推送；mirror 时改为镜像全部分支与标签。'

async function commitChanges(repo, message, paths, config, gitOptions) {
  // 已从工作区删除的路径不能被 `git add`（pathspec 不匹配），单独处理：
  // 只有它在索引里已经记录为删除时才允许提交，否则报错。
  const present = []
  const missing = []
  for (const entry of paths) {
    if (fs.existsSync(path.join(repo, entry))) present.push(entry)
    else missing.push(entry)
  }

  if (present.length > 0) {
    const added = await git(repo, ['add', '--', ...present], gitOptions)
    if (added.code !== 0) {
      return failure(classifyFailure(added), `git add 失败：${describeFailure(added)}`, { repo, output: added.stderr || added.stdout })
    }
  }

  if (missing.length > 0) {
    const deletions = await git(repo, ['diff', '--cached', '--name-only', '--diff-filter=D', '--', ...missing], gitOptions)
    const staged = deletions.stdout.split(/\r?\n/).filter(Boolean).map((entry) => entry.replace(/\\/g, '/'))
    // 传入的可能是目录（整棵删掉），所以按前缀覆盖判断，而不是逐字相等。
    const covered = (entry) => {
      const needle = entry.replace(/\\/g, '/').replace(/\/+$/, '')
      return staged.some((path) => path === needle || path.startsWith(`${needle}/`))
    }
    const unstaged = missing.filter((entry) => !covered(entry))
    if (deletions.code !== 0 || unstaged.length > 0) {
      const detail = unstaged.length > 0 ? `路径不存在且未标记删除：${unstaged.join(', ')}` : `读取删除状态失败：${describeFailure(deletions)}`
      return failure('path-not-matched', detail, { repo, output: deletions.stderr })
    }
  }

  const staged = await git(repo, ['diff', '--cached', '--name-only', '--', ...paths], gitOptions)
  if (staged.code !== 0) {
    return failure(classifyFailure(staged), `git diff --cached 失败：${describeFailure(staged)}`, { repo, output: staged.stderr })
  }
  if (staged.stdout.trim() === '') {
    return { committed: false, commit: '', detail: '这些路径没有可提交的改动' }
  }

  // 提交信息走 stdin，避免中文与换行在命令行里被二次解释；显式 pathspec 保证不带上别人暂存的内容。
  const committed = await git(repo, ['commit', '-F', '-', '--', ...paths], { ...gitOptions, input: `${message}\n` })
  if (committed.code !== 0) {
    return failure(classifyFailure(committed), `git commit 失败：${describeFailure(committed)}`, { repo, output: committed.stdout + committed.stderr })
  }
  const head = await git(repo, ['rev-parse', 'HEAD'], gitOptions)
  return { committed: true, commit: head.stdout.trim(), detail: committed.stdout.trim().split(/\r?\n/)[0] ?? '' }
}

async function publish(args, exec, config) {
  const remote = resolveRemote(args.remote, config)
  const mirror = args.mirror === true
  if (mirror) {
    // 镜像只推送已有引用；提交/换分支/不推送都会让语义打架，先拒绝，不跑任何 git。
    assertMirrorArgs(args)
    if (config.allowPush === false) throw new Error('mirror 需要 allowPush=true；当前配置禁止推送。')
  } else if (args.mirror !== undefined && typeof args.mirror !== 'boolean') {
    throw new Error('mirror 必须是布尔值。')
  }

  const repo = resolveRepo(args.repo, exec, config)
  assertAllowed(repo, config, exec)

  const gitOptions = { gitPath: config.gitPath, timeoutMs: config.timeoutMs }
  const top = await git(repo, ['rev-parse', '--show-toplevel'], gitOptions)
  if (top.code !== 0) {
    return failure(classifyFailure(top), `不是 git 仓库或无法读取：${describeFailure(top)}`, { repo })
  }
  // 允许 repo 指向仓库内的子目录：后续操作统一在仓库根执行。
  // git 回的是正斜杠路径，必须归一成真实路径，否则 isInside 在 Windows 上会误判越界。
  const root = realOrResolved(top.stdout.trim() === '' ? repo : top.stdout.trim())

  // 镜像不看分支：--all 推全部分支，detached HEAD 也照样能镜像。
  if (mirror) {
    const mirrored = await mirrorPush(root, remote, gitOptions)
    if (mirrored.ok === false) return { ...mirrored, repo: root, remote }
    return {
      ok: true,
      action: 'mirrored',
      repo: root,
      branch: '',
      commit: '',
      remote,
      pushed: true,
      upToDate: false,
      code: 'ok',
      detail: mirrored.detail,
      output: mirrored.output,
    }
  }

  const head = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'], gitOptions)
  if (head.code !== 0) return failure(classifyFailure(head), `读取分支失败：${describeFailure(head)}`, { repo: root })
  const branch = typeof args.branch === 'string' && args.branch.trim() !== '' ? args.branch.trim() : head.stdout.trim()
  if (branch === 'HEAD' || branch === '') {
    return failure('detached-head', '当前处于 detached HEAD，先切到分支再推送。', { repo: root })
  }

  let commit = ''
  let committed = false
  if (Array.isArray(args.paths) && args.paths.length > 0) {
    if (typeof args.message !== 'string' || args.message.trim() === '') throw new Error('提交需要 message。')
    const paths = validatePaths(root, args.paths)
    const result = await commitChanges(root, args.message, paths, config, gitOptions)
    if (result && result.ok === false) return result
    committed = result.committed === true
    commit = result.commit ?? ''
  }

  if (args.push === false || config.allowPush === false) {
    return {
      ok: true,
      action: committed ? 'committed' : 'nothing-to-do',
      repo: root,
      branch,
      commit,
      pushed: false,
      upToDate: false,
      code: 'ok',
      detail: committed ? '已提交，未推送（push=false 或 allowPush=false）' : '没有改动，也没有推送',
      output: '',
    }
  }

  const sync = await synchronize(root, branch, remote, config, gitOptions)
  // fetch 层面的问题（远端分支还不存在、超时、认证）不阻断推送，只在结果里注明；
  // 需要人处理的状态（rebase 冲突等）必须停下。
  let syncNote = ''
  if (sync.ok === false) {
    return { ...sync, commit, action: committed ? 'commit-failed-sync' : 'sync-failed' }
  }
  if (sync.skipped === true) syncNote = `同步已跳过（${sync.detail}）`
  if (sync.rebased === true || sync.fastForwarded === true) {
    const head = await git(root, ['rev-parse', 'HEAD'], gitOptions)
    if (head.code === 0) commit = head.stdout.trim()
  }

  const push = await pushBranch(root, branch, remote, gitOptions)
  if (push.ok === false) {
    return { ...push, repo: root, branch, commit, action: committed ? 'commit-failed-push' : 'push-failed' }
  }
  return {
    ok: true,
    action: committed ? 'committed-and-pushed' : 'pushed',
    repo: root,
    branch,
    commit,
    pushed: true,
    upToDate: push.upToDate === true,
    code: 'ok',
    detail: [
      syncNote,
      sync.rebased === true ? `已 rebase 到远端（${sync.behind} 个提交）` : '',
      sync.fastForwarded === true ? `已快进 ${sync.behind} 个提交` : '',
      push.detail ?? '',
    ]
      .filter(Boolean)
      .join('；'),
    output: push.output ?? '',
  }
}

function renderResult(value) {
  if (!value || value.ok !== true) {
    const code = value?.code ? `[${value.code}] ` : ''
    return `${code}${value?.detail ?? '推送失败'}${value?.output ? `\n${value.output}` : ''}`
  }
  if (value.action === 'mirrored') {
    const lines = [`已镜像（${value.repo || '仓库'} → ${value.remote || '?'}）`]
    if (value.detail) lines.push(value.detail)
    return lines.join('\n')
  }
  const lines = []
  const where = `${value.repo || '仓库'} @ ${value.branch || '?'}`
  if (value.commit) lines.push(`提交 ${value.commit.slice(0, 10)}（${where}）`)
  if (value.upToDate) lines.push('远端已是最新')
  else if (value.pushed) lines.push(`已推送（${where}）`)
  if (value.detail) lines.push(value.detail)
  return lines.join('\n')
}

export function apply(ctx, raw = {}) {
  const { config, errors } = normalizeConfig(raw)

  ctx.tools.register({
    name: 'repo_push',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
    },
    async execute(args, exec) {
      // 配置错误不阻塞宿主加载：调用时才明确报出来，避免插件静默消失。
      if (errors.length > 0) {
        return failure('invalid-config', `插件配置有误：${errors.join('；')}`)
      }
      try {
        return await publish(args ?? {}, exec, config)
      } catch (error) {
        const repo = typeof args?.repo === 'string' ? args.repo : ''
        return failure('invalid-args', String(error?.message ?? error), { repo })
      }
    },
    isConcurrencySafe: () => false,
  })
}
