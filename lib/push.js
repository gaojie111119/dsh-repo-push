// 推送路径：与远端对齐（fetch + ff-only/rebase）、推单个分支、镜像全部引用。
//
// runGit 默认是 lib/git.js 的 git，测试注入假实现来核对命令参数与顺序；
// 这样测试无需 spawn 子进程（受限沙箱同样拒绝带管道的子进程）。

import { classifyFailure, describeFailure, git } from './git.js'

/** 失败结果的统一形状；工具层与各推送步骤共用。 */
export function failure(code, detail, extra = {}) {
  return {
    ok: false,
    action: 'failed',
    code,
    detail,
    repo: extra.repo ?? '',
    branch: extra.branch ?? '',
    commit: extra.commit ?? '',
    pushed: false,
    upToDate: false,
    output: extra.output ?? '',
  }
}

/**
 * 推一个分支。远端已设 upstream 就不带 -u，否则首次推送建立跟踪。
 * @param {string} remote 已通过 remotes 白名单校验的远端名
 */
export async function pushBranch(repo, branch, remote, gitOptions, runGit = git) {
  const upstream = await runGit(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitOptions)
  const args = upstream.code === 0
    ? ['push', remote, branch]
    : ['push', '-u', remote, branch]
  const pushed = await runGit(repo, args, gitOptions)
  const output = `${pushed.stdout}\n${pushed.stderr}`.trim()
  if (pushed.code !== 0) {
    return failure(classifyFailure(pushed), `git push 失败：${describeFailure(pushed)}`, { repo, branch, output })
  }
  const upToDate = /everything up-to-date/i.test(output)
  return { pushed: true, upToDate, detail: output.split(/\r?\n/).slice(-2).join(' / '), output }
}

/** git 不允许 --all 与 --tags 同时出现，所以镜像固定拆成两条；顺序即执行顺序。 */
export function mirrorCommands(remote) {
  return [
    ['push', remote, '--all'],
    ['push', remote, '--tags'],
  ]
}

/**
 * 镜像：把全部分支与标签推到 remote；第一条失败就停，不在半途继续。
 * 不 add/commit、不 fetch、不 rebase，也不 force（--mirror 会删镜像侧引用，刻意不用）。
 */
export async function mirrorPush(repo, remote, gitOptions, runGit = git) {
  let output = ''
  for (const args of mirrorCommands(remote)) {
    const result = await runGit(repo, args, gitOptions)
    const text = `${result.stdout}\n${result.stderr}`.trim()
    output = output === '' ? text : `${output}\n${text}`
    if (result.code !== 0) {
      return failure(classifyFailure(result), `git ${args.join(' ')} 失败：${describeFailure(result)}`, { repo, output })
    }
  }
  const detail = output === '' ? '已推送全部分支与标签' : output.split(/\r?\n/).slice(-2).join(' / ')
  return { action: 'mirrored', remote, pushed: true, upToDate: false, detail, output }
}

/** mirror 只推送已有引用：任何“提交 / 换分支 / 不推送”的入参都会制造歧义，明确拒绝。 */
export function assertMirrorArgs(args) {
  const rejected = []
  if (Array.isArray(args.paths) && args.paths.length > 0) rejected.push('paths')
  if (typeof args.message === 'string' && args.message.trim() !== '') rejected.push('message')
  if (typeof args.branch === 'string' && args.branch.trim() !== '') rejected.push('branch')
  if (args.push === false) rejected.push('push=false')
  if (rejected.length > 0) {
    throw new Error(`mirror 模式不接受 ${rejected.join(' / ')}：镜像只推送已有分支与标签，不提交、不 fetch、不选分支。`)
  }
}

/**
 * 推送前先与远端对齐（沙箱里 agent 自己跑不了 pull，网络传输同样撞管道限制）。
 *   none   —— 不动
 *   ff-only—— 只在"本地无新提交"时快进合并；分叉则报错，不改历史
 *   rebase —— 把本地提交重放到远端之上；冲突则 abort 回原状
 * @returns 成功时 {ok:true, ...}，失败时返回 failure 结构。
 */
export async function synchronize(repo, branch, remote, config, gitOptions, runGit = git) {
  if (config.sync === 'none') return { ok: true }
  const fetched = await runGit(repo, ['fetch', '--no-tags', remote, branch], gitOptions)
  if (fetched.code !== 0) {
    // 远端分支还不存在（首次推送）、网络抖动、认证问题——都不该挡住推送本身：
    // 跳过同步并注明，真正的错误由随后的 push 报出来。
    return { ok: true, skipped: true, detail: describeFailure(fetched) }
  }
  const counts = await runGit(repo, ['rev-list', '--left-right', '--count', 'HEAD...FETCH_HEAD'], gitOptions)
  if (counts.code !== 0) {
    return failure(classifyFailure(counts), `比较远端失败：${describeFailure(counts)}`, { repo, branch, output: counts.stderr })
  }
  const [aheadText, behindText] = counts.stdout.trim().split(/\s+/)
  const ahead = Number(aheadText) || 0
  const behind = Number(behindText) || 0
  if (behind === 0) return { ok: true, ahead, behind }

  if (config.sync === 'ff-only') {
    if (ahead > 0) {
      return failure('non-fast-forward', `远端已前进 ${behind} 个提交，本地还有 ${ahead} 个未推提交；sync=ff-only 不改历史，请改用 sync=rebase 或人工处理。`, { repo, branch })
    }
    const merged = await runGit(repo, ['merge', '--ff-only', 'FETCH_HEAD'], gitOptions)
    if (merged.code !== 0) {
      return failure(classifyFailure(merged), `git merge --ff-only 失败：${describeFailure(merged)}`, { repo, branch, output: merged.stderr })
    }
    return { ok: true, ahead, behind, fastForwarded: true }
  }

  // rebase：autoStash 让未提交的改动先暂存，失败时整体 abort，仓库回到动之前的状态。
  const rebased = await runGit(repo, ['-c', 'rebase.autoStash=true', 'rebase', 'FETCH_HEAD'], gitOptions)
  if (rebased.code !== 0) {
    const aborted = await runGit(repo, ['rebase', '--abort'], gitOptions)
    const recovered = aborted.code === 0 ? '已 abort，仓库回到 rebase 之前' : 'abort 也失败了，需要人工处理'
    return failure('rebase-conflict', `git rebase 冲突（${recovered}）：${describeFailure(rebased)}`, { repo, branch, output: rebased.stderr })
  }
  return { ok: true, ahead, behind, rebased: true }
}
