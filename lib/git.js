// 宿主进程内的 git 调用封装。
//
// 为什么需要它：Windows 下 DSH 用「受限令牌 + Low 完整性 + write-restricted SID」隔离子进程，
// 受限进程无法为子进程创建管道 stdio（命名管道的 client 端拿不到 restricting SID 授权），
// 于是 git 给 ssh.exe / git-remote-https / git-receive-pack 建 stdin 管道时失败：
//   error: cannot create standard input pipe for ...\ssh.exe: Permission denied
//   fatal: unable to fork
// 这与 SSH、远端、认证都无关，换 https 一样失败；本地 add/commit 不受影响。
// 本模块的调用发生在 DSH 宿主进程里，不经过沙箱 seam，所以管道可用。

import { spawn } from 'node:child_process'
import path from 'node:path'

const OUTPUT_LIMIT = 256 * 1024

/**
 * 执行一个子进程并收集输出。宿主进程里管道可用，因此统一用 pipe stdio。
 * @returns {Promise<{code:number|null,stdout:string,stderr:string,timedOut:boolean,spawnError?:string}>}
 */
export function runProcess(file, args, options = {}) {
  const { cwd, env, timeoutMs = 120_000, input } = options
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(file, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: String(error?.message ?? error) })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const append = (buffer, chunk) => {
      const next = buffer + chunk.toString('utf8')
      return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next
    }

    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk) })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    child.on('error', (error) => finish({ code: null, stdout, stderr, timedOut, spawnError: String(error?.message ?? error) }))
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut }))

    if (input !== undefined && input !== null) child.stdin.end(String(input), 'utf8')
    else child.stdin.end()
  })
}

/** 组装 git 运行环境：强制原生 OpenSSH，禁止交互式提示。 */
export function gitEnv(overrides = {}) {
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'true',
    ...overrides,
  }
  // MSYS 版 ssh 需要命名管道；宿主里也应优先原生 OpenSSH，行为与命令行一致。
  if (!env.GIT_SSH && process.platform === 'win32' && process.env.SystemRoot) {
    const ssh = path.join(process.env.SystemRoot, 'System32', 'OpenSSH', 'ssh.exe')
    env.GIT_SSH = ssh
  }
  if (env.GIT_SSH) env.GIT_SSH_VARIANT = env.GIT_SSH_VARIANT ?? 'ssh'
  return env
}

/** 一次 git 调用；cwd 固定为仓库根，避免 -C 与相对路径的歧义。 */
export async function git(repo, args, options = {}) {
  const { gitPath = 'git', timeoutMs, input, extraEnv } = options
  return runProcess(gitPath, args, {
    cwd: repo,
    env: gitEnv(extraEnv),
    timeoutMs,
    input,
  })
}

/** 失败时给出人类可读的一行摘要。 */
export function describeFailure(result) {
  if (result.spawnError) return `无法启动 git：${result.spawnError}`
  if (result.timedOut) return 'git 执行超时'
  const text = (result.stderr || result.stdout || '').trim()
  return text === '' ? `git 退出码 ${result.code}` : text.split(/\r?\n/).slice(-3).join(' / ')
}

/** 把常见 git 错误归类成稳定代码，便于调用方决策。 */
export function classifyFailure(result) {
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  if (result.spawnError) return 'spawn-failed'
  if (result.timedOut) return 'timeout'
  if (/permission denied \(publickey|authentication failed|could not read from remote repository/.test(text)) return 'auth'
  if (/could not resolve host|connection (?:timed out|refused|reset)|network is unreachable|failed to connect/.test(text)) return 'network'
  if (/non-fast-forward|\[rejected\]|fetch first|updates were rejected/.test(text)) return 'non-fast-forward'
  if (/pathspec .* did not match/.test(text)) return 'path-not-matched'
  if (/not a git repository/.test(text)) return 'not-a-repo'
  return 'git-failed'
}
