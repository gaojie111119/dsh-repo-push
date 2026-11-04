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
  resolveRepo,
  resolveRoot,
  validatePaths,
} from '../lib/config.js'
import { classifyFailure, describeFailure, gitEnv } from '../lib/git.js'

const cases = []
const test = (name, fn) => cases.push({ name, fn })
const win = process.platform === 'win32'
// 构造"绝对且在工作区之外"的路径：'C:/x' 在 POSIX 上是相对路径，会落回工作区内。
const external = (name) => path.join(os.tmpdir(), `dsh-repo-push-${name}`)

test('normalizeConfig: 空配置给出默认值', () => {
  const { config, errors } = normalizeConfig(undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config.repos, [])
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
