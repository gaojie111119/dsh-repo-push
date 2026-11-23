// 零依赖测试：单进程顺序执行，不 spawn 子进程（受限沙箱里 node --test 的子进程同样会被拒）。
// 运行：node test/run.mjs

import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import {
  allowedRoots,
  assertAllowed,
  globToRegExp,
  isInside,
  matchesPattern,
  normalizeConfig,
  realOrResolved,
  resolveRemote,
  resolveRepo,
  resolveRoot,
  validatePaths,
} from '../lib/config.js'
import { classifyFailure, describeFailure, gitEnv } from '../lib/git.js'
import { apply } from '../lib/index.js'
import { assertMirrorArgs, mirrorPush, pushBranch, synchronize } from '../lib/push.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })
const win = process.platform === 'win32'
// 构造"绝对且在工作区之外"的路径：'C:/x' 在 POSIX 上是相对路径，会落回工作区内。
const external = (name) => path.join(os.tmpdir(), `dsh-repo-push-${name}`)

// 假 git：按「参数拼成的命令」回放结果，并记录每次调用的参数。
// 这样能核对推送命令与顺序，又不必 spawn 子进程。
function fakeGit(responses = {}) {
  const calls = []
  const run = async (repo, args, options) => {
    calls.push({ repo, args, options })
    const found = Object.hasOwn(responses, args.join(' ')) ? responses[args.join(' ')] : { code: 0, stdout: '', stderr: '' }
    return typeof found === 'function' ? found(args) : found
  }
  return { calls, run }
}

test('normalizeConfig: 空配置给出默认值', () => {
  const { config, errors } = normalizeConfig(undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config.repos, [])
  assert.deepEqual(config.remotes, ['origin'])
  assert.equal(config.remote, 'origin')
  assert.equal(config.allowPush, true)
  assert.equal(config.timeoutMs, 120_000)
  assert.equal(config.gitPath, 'git')
})

test('normalizeConfig: repos 保留原始写法，不在加载时解析', () => {
  const { config, errors } = normalizeConfig({ repos: [' docs ', 'C:/docs'] })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.repos, ['docs', 'C:/docs'])
})

test('resolveRoot: 绝对路径原样，相对路径跟随会话工作区', () => {
  const exec = { agent: { session: { header: { cwd: 'C:/work' } } } }
  assert.equal(resolveRoot(path.resolve('C:/docs'), exec), path.resolve('C:/docs'))
  assert.equal(resolveRoot('docs', exec), path.resolve('C:/work/docs'))
  assert.equal(resolveRoot('docs', {}), undefined)
})

test('allowedRoots: 相对根只在当前工作区存在时生效', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const { config } = normalizeConfig({ repos: ['test', 'nope'] })
  assert.deepEqual(allowedRoots(config, here), [path.resolve('test')])
})

test('allowedRoots: 绝对根不受存在性影响', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const missing = path.resolve('C:/definitely/missing')
  const { config } = normalizeConfig({ repos: [missing] })
  assert.deepEqual(allowedRoots(config, here), [missing])
})

test('resolveRepo: 默认取工作区内的唯一可用根（多工作区共用一份配置）', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const { config } = normalizeConfig({ repos: ['test', 'nope'], allowDefaultRepo: true })
  assert.equal(resolveRepo(undefined, here, config), path.resolve('test'))
})

test('resolveRepo: 唯一根但不在当前工作区内时不猜', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const { config } = normalizeConfig({ repos: [external('docs')], allowDefaultRepo: true })
  assert.throws(() => resolveRepo(undefined, here, config), /都与当前工作区无关/)
})

test('resolveRepo: 多个根且都不含工作区时要求显式指定', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const { config } = normalizeConfig({ repos: [external('a'), external('b')], allowDefaultRepo: true })
  assert.throws(() => resolveRepo(undefined, here, config), /都与当前工作区无关/)
})

test('resolveRepo: 多个根但工作区落在其中一个根内时用工作区', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const { config } = normalizeConfig({ repos: [process.cwd(), external('b')], allowDefaultRepo: true })
  assert.equal(resolveRepo(undefined, here, config), realOrResolved(process.cwd()))
})

test('resolveRepo: 优先选工作区内的那个根，而不是无关的绝对根', () => {
  const here = { agent: { session: { header: { cwd: process.cwd() } } } }
  const { config } = normalizeConfig({ repos: [path.join(process.cwd(), 'test'), external('unrelated')], allowDefaultRepo: true })
  assert.equal(resolveRepo(undefined, here, config), path.join(process.cwd(), 'test'))
})

test('resolveRoot: ~ 展开到用户目录', () => {
  assert.equal(resolveRoot('~/.dsh', {}), realOrResolved(path.join(os.homedir(), '.dsh')))
})

test('globToRegExp: ** 跨目录，* 不跨目录', () => {
  assert.equal(globToRegExp('**/*-notes').test('docs/team-notes'), true)
  assert.equal(globToRegExp('**/*-notes').test('team-notes'), true)
  assert.equal(globToRegExp('**/*-notes').test('docs/other'), false)
  assert.equal(globToRegExp('docs/*').test('docs/a/b'), false)
})

test('matchesPattern: 相对模式按工作区相对路径匹配，不允许越出工作区', () => {
  const here = { agent: { session: { header: { cwd: path.resolve('C:/work') } } } }
  assert.equal(matchesPattern(path.resolve('C:/work/docs/team-notes'), '**/*-notes', here), true)
  assert.equal(matchesPattern(path.resolve('C:/work/team-notes'), '**/*-notes', here), true)
  assert.equal(matchesPattern(path.resolve('C:/other/team-notes'), '**/*-notes', here), false)
})

test('assertAllowed: patterns 命中即放行', () => {
  const here = { agent: { session: { header: { cwd: path.resolve('C:/work') } } } }
  const { config } = normalizeConfig({ patterns: ['**/*-notes'] })
  assert.doesNotThrow(() => assertAllowed(path.resolve('C:/work/docs/team-notes'), config, here))
  assert.throws(() => assertAllowed(path.resolve('C:/work/src'), config, here), /不在允许清单内/)
})

test('normalizeConfig: sync 默认 ff-only，非法值记错误', () => {
  assert.equal(normalizeConfig({}).config.sync, 'ff-only')
  assert.equal(normalizeConfig({ sync: 'rebase' }).config.sync, 'rebase')
  assert.equal(normalizeConfig({ sync: 'none' }).config.sync, 'none')
  const { errors } = normalizeConfig({ sync: 'merge' })
  assert.equal(errors.length, 1)
  assert.ok(errors[0].includes('sync'))
})

test('normalizeConfig: remotes 去空去重，保留书写顺序', () => {
  const { config, errors } = normalizeConfig({ remotes: [' github ', '', 'origin', 'github'] })
  assert.deepEqual(errors, [])
  assert.deepEqual(config.remotes, ['github', 'origin'])
})

test('normalizeConfig: remote 名必须是安全字符，且落在 remotes 内', () => {
  const bad = normalizeConfig({ remotes: ['origin', 'bad name'] })
  assert.ok(bad.errors.some((e) => e.includes('不合法')), bad.errors.join('；'))
  const empty = normalizeConfig({ remotes: [] })
  assert.ok(empty.errors.some((e) => e.includes('至少')), empty.errors.join('；'))
  const missing = normalizeConfig({ remote: 'github' })
  assert.ok(missing.errors.some((e) => e.includes('必须在 remotes 中')), missing.errors.join('；'))
  const ok = normalizeConfig({ remote: 'github', remotes: ['origin', 'github'] })
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.config.remote, 'github')
})

test('resolveRemote: 默认用 config.remote，只接受 remotes 里的名字（其余由 execute 转 invalid-args）', () => {
  const { config } = normalizeConfig({ remotes: ['origin', 'github'] })
  assert.equal(resolveRemote(undefined, config), 'origin')
  assert.equal(resolveRemote(' github ', config), 'github')
  assert.throws(() => resolveRemote('upstream', config), /不在允许清单内/)
  assert.throws(() => resolveRemote('--upload-pack=evil', config), /不合法/)
})

test('normalizeConfig: 非法值只记错误，不抛异常', () => {
  const { errors } = normalizeConfig({ repos: 'not-an-array', timeoutMs: -1, allowPush: 'yes', remote: '  ' })
  assert.equal(errors.length, 4)
  assert.ok(errors.some((e) => e.includes('repos')))
  assert.ok(errors.some((e) => e.includes('timeoutMs')))
  assert.ok(errors.some((e) => e.includes('allowPush')))
  assert.ok(errors.some((e) => e.includes('remote')))
})

test('normalizeConfig: 非对象配置直接报错', () => {
  const { errors } = normalizeConfig(['x'])
  assert.equal(errors.length, 1)
})

test('allowedRoots: 未配置 repos 时退化为会话工作区', () => {
  const { config } = normalizeConfig({})
  const exec = { agent: { session: { header: { cwd: 'C:/work' } } } }
  assert.deepEqual(allowedRoots(config, exec), [path.resolve('C:/work')])
  assert.deepEqual(allowedRoots(config, {}), [])
})

test('resolveRepo: 默认关闭时不给 repo 直接报错', () => {
  const exec = { agent: { session: { header: { cwd: 'C:/work' } } } }
  const { config } = normalizeConfig({})
  assert.equal(config.allowDefaultRepo, false)
  assert.throws(() => resolveRepo(undefined, exec, config), /必须显式指定 repo/)
})

test('resolveRepo: 相对路径按会话工作区解析', () => {
  const { config } = normalizeConfig({})
  const exec = { agent: { session: { header: { cwd: 'C:/work' } } } }
  assert.equal(resolveRepo('docs', exec, config), path.resolve('C:/work/docs'))
})

test('resolveRepo: defaultRepo 优先于会话工作区', () => {
  // 用 path.resolve 构造绝对路径：'C:/…' 在 POSIX 上不是绝对路径，直接写字面量会跨平台失败。
  const defaultRepo = path.resolve('C:/docs-repo')
  const { config } = normalizeConfig({ defaultRepo, allowDefaultRepo: true })
  const exec = { agent: { session: { header: { cwd: path.resolve('C:/work') } } } }
  assert.equal(resolveRepo(undefined, exec, config), defaultRepo)
})

test('assertAllowed: 白名单外的仓库被拒', () => {
  const allowed = path.resolve('C:/allowed')
  const { config } = normalizeConfig({ repos: [allowed] })
  const exec = { agent: { session: { header: { cwd: path.resolve('C:/work') } } } }
  assert.doesNotThrow(() => assertAllowed(path.resolve(allowed, 'repo'), config, exec))
  assert.throws(() => assertAllowed(path.resolve('C:/other/repo'), config, exec), /不在允许清单内/)
})

test('isInside: 前缀相似但不是子目录不算命中', () => {
  assert.equal(isInside(path.resolve('/x/repo'), path.resolve('/x/repo')), true)
  assert.equal(isInside(path.resolve('/x/repo/sub'), path.resolve('/x/repo')), true)
  assert.equal(isInside(path.resolve('/x/repo-evil'), path.resolve('/x/repo')), false)
})

test('isInside: Windows 上路径大小写不敏感', () => {
  if (!win) return
  assert.equal(isInside(path.resolve('C:/Docs/Repo'), path.resolve('c:/docs')), true)
})

test('isInside: Windows 上正反斜杠混用也能判定（git 回的是正斜杠）', () => {
  if (!win) return
  assert.equal(isInside('C:/work/repo/a.md', 'C:\\work\\repo'), true)
  assert.equal(isInside('C:\\work\\repo\\a.md', 'C:/work/repo/'), true)
})

test('validatePaths: 拒绝绝对路径与越界路径', () => {
  const root = path.resolve('C:/repo')
  assert.deepEqual(validatePaths(root, ['skills/a.md', 'skills/a.md']), ['skills/a.md'])
  assert.throws(() => validatePaths(root, [path.resolve('C:/repo/a.md')]), /相对路径/)
  assert.throws(() => validatePaths(root, ['../escape.md']), /越出仓库/)
  assert.throws(() => validatePaths(root, ['']), /空值/)
})

test('classifyFailure: 常见错误归类', () => {
  assert.equal(classifyFailure({ code: 128, stdout: '', stderr: 'Permission denied (publickey).' }), 'auth')
  assert.equal(classifyFailure({ code: 128, stdout: '', stderr: 'fatal: unable to access: Could not resolve host: github.com' }), 'network')
  assert.equal(classifyFailure({ code: 1, stdout: '', stderr: '! [rejected] main -> main (non-fast-forward)' }), 'non-fast-forward')
  assert.equal(classifyFailure({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }), 'spawn-failed')
  assert.equal(classifyFailure({ code: 1, stdout: '', stderr: '', timedOut: true }), 'timeout')
  assert.equal(classifyFailure({ code: 1, stdout: '', stderr: 'something else' }), 'git-failed')
})

test('describeFailure: 取 stderr 末三行', () => {
  const text = describeFailure({ code: 1, stdout: '', stderr: 'a\nb\nc\nd' })
  assert.equal(text, 'b / c / d')
  assert.equal(describeFailure({ code: null, stdout: '', stderr: '', spawnError: 'ENOENT' }), '无法启动 git：ENOENT')
})

test('gitEnv: Windows 上补原生 OpenSSH 且禁止交互提示', () => {
  const env = gitEnv()
  assert.equal(env.GIT_TERMINAL_PROMPT, '0')
  if (win && process.env.SystemRoot) {
    assert.ok(env.GIT_SSH.endsWith('ssh.exe'))
    assert.equal(env.GIT_SSH_VARIANT, 'ssh')
  }
})

test('pushBranch: 默认 remote=origin，命令与 0.2.x 一致', async () => {
  const { config } = normalizeConfig({})
  const remote = resolveRemote(undefined, config)
  const { calls, run } = fakeGit({
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 0, stdout: 'origin/main\n', stderr: '' },
    'push origin main': { code: 0, stdout: 'abc1234..def5678  main -> main', stderr: '' },
  })
  const result = await pushBranch('/repo', 'main', remote, {}, run)
  assert.equal(result.pushed, true)
  assert.deepEqual(calls.map((call) => call.args), [
    ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
    ['push', 'origin', 'main'],
  ])
})

test('pushBranch: 首次推送保留 -u，并使用指定的 remote', async () => {
  const { config } = normalizeConfig({ remote: 'mirror', remotes: ['origin', 'mirror'] })
  const remote = resolveRemote('mirror', config)
  const { calls, run } = fakeGit({
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': { code: 128, stdout: '', stderr: 'fatal: no upstream configured' },
  })
  const result = await pushBranch('/repo', 'main', remote, {}, run)
  assert.equal(result.pushed, true)
  assert.deepEqual(calls[1].args, ['push', '-u', 'mirror', 'main'])
})

test('synchronize: fetch 使用选中的 remote', async () => {
  const { config } = normalizeConfig({})
  const { calls, run } = fakeGit({
    'fetch --no-tags mirror main': { code: 0, stdout: '', stderr: '' },
    'rev-list --left-right --count HEAD...FETCH_HEAD': { code: 0, stdout: '0\t0\n', stderr: '' },
  })
  const result = await synchronize('/repo', 'main', 'mirror', config, {}, run)
  assert.equal(result.ok, true)
  assert.deepEqual(calls[0].args, ['fetch', '--no-tags', 'mirror', 'main'])
})

test('synchronize: sync=none 不执行任何 git 命令', async () => {
  const { config } = normalizeConfig({ sync: 'none' })
  const { calls, run } = fakeGit()
  const result = await synchronize('/repo', 'main', 'origin', config, {}, run)
  assert.equal(result.ok, true)
  assert.equal(calls.length, 0)
})

test('mirrorPush: 先 --all 再 --tags，成功返回 mirrored', async () => {
  const { calls, run } = fakeGit()
  const result = await mirrorPush('/repo', 'mirror', {}, run)
  assert.deepEqual(calls.map((call) => call.args), [
    ['push', 'mirror', '--all'],
    ['push', 'mirror', '--tags'],
  ])
  assert.equal(result.action, 'mirrored')
  assert.equal(result.remote, 'mirror')
  assert.equal(result.pushed, true)
})

test('mirrorPush: 第一条失败即停，不再推 tags', async () => {
  const { calls, run } = fakeGit({
    'push mirror --all': { code: 128, stdout: '', stderr: 'fatal: could not read from remote repository.' },
  })
  const result = await mirrorPush('/repo', 'mirror', {}, run)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'auth')
  assert.equal(calls.length, 1)
})

test('assertMirrorArgs: 拒绝 paths / message / branch / push=false', () => {
  assert.doesNotThrow(() => assertMirrorArgs({ mirror: true, paths: [], message: '  ' }))
  assert.throws(() => assertMirrorArgs({ paths: ['a.md'] }), /paths/)
  assert.throws(() => assertMirrorArgs({ message: 'docs: x' }), /message/)
  assert.throws(() => assertMirrorArgs({ branch: 'main' }), /branch/)
  assert.throws(() => assertMirrorArgs({ push: false }), /push=false/)
})

// 用假 ctx 捕获注册的工具定义，验证参数校验确实在工具层生效，且失败前不跑 git。
function captureTool(config) {
  let definition
  apply({ tools: { register(value) { definition = value } } }, config)
  return definition
}

test('repo_push: mirror 拒绝 paths / message，返回 invalid-args', async () => {
  const tool = captureTool({})
  const withPaths = await tool.execute({ repo: 'x', mirror: true, paths: ['a.md'] }, {})
  assert.equal(withPaths.ok, false)
  assert.equal(withPaths.code, 'invalid-args')
  assert.match(withPaths.detail, /paths/)
  const withMessage = await tool.execute({ repo: 'x', mirror: true, message: 'docs: x' }, {})
  assert.equal(withMessage.code, 'invalid-args')
  assert.match(withMessage.detail, /message/)
})

test('repo_push: remote 不在 remotes 中返回 invalid-args', async () => {
  const tool = captureTool({ remotes: ['origin'] })
  const result = await tool.execute({ repo: 'x', remote: 'github' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-args')
  assert.match(result.detail, /不在允许清单内/)
})

test('repo_push: 配置错误返回 invalid-config，且不跑 git', async () => {
  const tool = captureTool({ remote: 'github' })
  const result = await tool.execute({ repo: 'x' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.code, 'invalid-config')
  assert.match(result.detail, /remotes/)
})

test('repo_push: mirror 需要 allowPush=true', async () => {
  const tool = captureTool({ allowPush: false })
  const result = await tool.execute({ repo: 'x', mirror: true }, {})
  assert.equal(result.code, 'invalid-args')
  assert.match(result.detail, /allowPush/)
})

let failed = 0
for (const { name, fn } of cases) {
  try {
    await fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}
console.log(`\n${cases.length - failed}/${cases.length} passed`)
process.exit(failed === 0 ? 0 : 1)
