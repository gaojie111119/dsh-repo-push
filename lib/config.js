// 配置解析与安全边界。
//
// 这里刻意不依赖任何包（包括 schema 库）：本插件常用 `link:` 方式装进 profile，
// 链接包的依赖不会被 pnpm 装到它自己目录，声明依赖反而会让宿主解析失败。
// 因此配置在 apply() 时手写校验，错误留到调用时以 invalid-config 返回，绝不让宿主加载失败。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 缺省值；README 与测试都以这份为事实。 */
export const DEFAULTS = Object.freeze({
  repos: [],
  patterns: [],
  defaultRepo: '',
  remote: 'origin',
  sync: 'ff-only',
  allowPush: true,
  allowDefaultRepo: false,
  timeoutMs: 120_000,
  gitPath: 'git',
})

/** 推送前的对齐方式。 */
export const SYNC_MODES = Object.freeze(['none', 'ff-only', 'rebase'])

const isString = (value) => typeof value === 'string'
const isNonEmpty = (value) => isString(value) && value.trim() !== ''

export function realOrResolved(target) {
  const absolute = path.resolve(target)
  try {
    return fs.realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

/** Windows 上路径大小写不敏感、分隔符可混用（git 回的是正斜杠）；父子判定统一在这里做。 */
export function isInside(candidate, root) {
  const norm = (value) => {
    // 去掉末尾分隔符后再比较，避免 "C:\a\" 与 "C:\a" 判成不同根。
    const normalized = path.normalize(value)
    return normalized.length > 1 && normalized.endsWith(path.sep) ? normalized.slice(0, -1) : normalized
  }
  const fold = (value) => (process.platform === 'win32' ? norm(value).toLowerCase() : norm(value))
  const child = fold(candidate)
  const parent = fold(root)
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep)
}

/**
 * 解析并校验插件配置。任何一项不合法都记进 errors，而不是抛出。
 * @returns {{config: object, errors: string[]}}
 */
export function normalizeConfig(raw) {
  const errors = []
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { config: { ...DEFAULTS }, errors: ['配置必须是对象（YAML mapping）'] }
  }

  const repos = []
  const rawRepos = input.repos ?? []
  if (!Array.isArray(rawRepos)) {
    errors.push('repos 必须是字符串数组')
  } else {
    for (const item of rawRepos) {
      if (!isNonEmpty(item)) {
        errors.push('repos 只能包含非空字符串路径')
        continue
      }
      // 保留原始写法：绝对路径原样用，相对路径在每次调用时按会话工作区解析。
      repos.push(item.trim())
    }
  }

  let defaultRepo = ''
  if (input.defaultRepo !== undefined && input.defaultRepo !== '') {
    if (!isNonEmpty(input.defaultRepo)) errors.push('defaultRepo 必须是非空字符串路径')
    else defaultRepo = input.defaultRepo.trim()
  }

  const patterns = []
  const rawPatterns = input.patterns ?? []
  if (!Array.isArray(rawPatterns)) {
    errors.push('patterns 必须是字符串数组')
  } else {
    for (const item of rawPatterns) {
      if (!isNonEmpty(item)) {
        errors.push('patterns 只能包含非空字符串')
        continue
      }
      patterns.push(item.trim())
    }
  }

  let remote = DEFAULTS.remote
  if (input.remote !== undefined) {
    if (!isNonEmpty(input.remote)) errors.push('remote 必须是非空字符串')
    else remote = input.remote.trim()
  }

  let sync = DEFAULTS.sync
  if (input.sync !== undefined) {
    if (!SYNC_MODES.includes(input.sync)) errors.push(`sync 只能是 ${SYNC_MODES.join(' / ')}`)
    else sync = input.sync
  }

  let allowPush = DEFAULTS.allowPush
  if (input.allowPush !== undefined) {
    if (typeof input.allowPush !== 'boolean') errors.push('allowPush 必须是布尔值')
    else allowPush = input.allowPush
  }

  let allowDefaultRepo = DEFAULTS.allowDefaultRepo
  if (input.allowDefaultRepo !== undefined) {
    if (typeof input.allowDefaultRepo !== 'boolean') errors.push('allowDefaultRepo 必须是布尔值')
    else allowDefaultRepo = input.allowDefaultRepo
  }

  let timeoutMs = DEFAULTS.timeoutMs
  if (input.timeoutMs !== undefined) {
    if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) errors.push('timeoutMs 必须是正数')
    else timeoutMs = input.timeoutMs
  }

  let gitPath = DEFAULTS.gitPath
  if (input.gitPath !== undefined) {
    if (!isNonEmpty(input.gitPath)) errors.push('gitPath 必须是非空字符串')
    else gitPath = input.gitPath
  }

  return {
    config: { repos, patterns, defaultRepo, remote, sync, allowPush, allowDefaultRepo, timeoutMs, gitPath },
    errors,
  }
}

/** 会话工作区（宿主里没有 DSH_HOME，只能从执行上下文取）。 */
export function sessionRoot(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return isNonEmpty(cwd) ? realOrResolved(cwd) : undefined
}

/**
 * 解析一个配置里的仓库根：`~` 展开成用户目录；绝对路径原样解析；
 * 相对路径按**会话工作区**解析，这样同一份配置能在不同工作区跟随各自的目录结构。
 * @returns 解析后的绝对路径；相对路径且拿不到会话工作区时返回 undefined。
 */
export function resolveRoot(entry, exec) {
  const expanded = expandHome(entry)
  if (path.isAbsolute(expanded)) return realOrResolved(expanded)
  const root = sessionRoot(exec)
  return root ? realOrResolved(path.resolve(root, expanded)) : undefined
}

/** 只认 `~/` 与 `~\` 两种前缀；不动其它写法。 */
function expandHome(entry) {
  if (entry === '~') return os.homedir()
  if (entry.startsWith('~/') || entry.startsWith('~\\')) return path.join(os.homedir(), entry.slice(2))
  return entry
}

/**
 * 相对写法是「当前工作区里存在这个子目录才生效」，不存在就跳过。
 * 这样一份配置能适配"不同工作区里文档仓位置不同"的布局，例如：
 *   repos: [docs/team-notes, team-notes]
 * 在甲工作区命中第一个，在乙工作区命中第二个。
 */
function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/** 未配置 repos 时，白名单退化为「会话工作区」本身；但只配了 patterns 时不再回落（否则根仓会被一并授权）。 */
export function allowedRoots(config, exec) {
  if (config.repos.length > 0) {
    const roots = []
    for (const entry of config.repos) {
      const resolved = resolveRoot(entry, exec)
      if (!resolved) continue
      const relative = !path.isAbsolute(expandHome(entry))
      if (relative && !isDirectory(resolved)) continue
      roots.push(resolved)
    }
    return roots
  }
  if (config.patterns.length > 0) return []
  const root = sessionRoot(exec)
  return root ? [root] : []
}

/**
 * 决定"没传 repo 时推哪个仓库"。顺序：
 * defaultRepo → 唯一可用根 → 工作区内唯一命中根 → 包含工作区的那个根。
 * 剩多个候选且无法消歧时**报错**，绝不猜（猜错会推到别人的仓）。
 * patterns 不参与默认解析：它只回答"能不能推"，推哪个仍需具体路径。
 */
export function resolveRepo(argument, exec, config) {
  const roots = allowedRoots(config, exec)
  if (isNonEmpty(argument)) {
    const base = sessionRoot(exec) ?? process.cwd()
    return realOrResolved(path.isAbsolute(argument) ? argument : path.resolve(base, argument))
  }
  // 默认关闭：不给 repo 就不猜，避免任何"顺手推错仓"的可能。
  if (!config.allowDefaultRepo) {
    throw new Error('必须显式指定 repo：默认仓库解析已关闭（配置项 allowDefaultRepo，默认 false）。')
  }
  if (config.defaultRepo !== '') {
    const resolved = resolveRoot(config.defaultRepo, exec)
    if (resolved) return resolved
  }
  const workspace = sessionRoot(exec)
  if (workspace) {
    const inside = roots.filter((root) => isInside(root, workspace))
    if (inside.length === 1) return inside[0]
    if (inside.length > 1) {
      throw new Error(`当前工作区内有多个可用仓库（${inside.join(' / ')}），请用 repo 参数指定。`)
    }
    if (roots.some((root) => isInside(workspace, root))) return workspace
  }
  if (roots.length === 0) {
    const hint = config.patterns.length > 0 ? 'patterns 只放宽能推哪些仓，不参与默认解析' : '请传 repo，或在插件配置里设 repos / defaultRepo'
    throw new Error(`没有可推送的仓库：${hint}。`)
  }
  // 只有"唯一根且与当前工作区无关"时不猜：那多半是给别的工作区配的。
  throw new Error(`配置里的仓库都与当前工作区无关（${roots.join(' / ')}）；请用 repo 参数指定，或设 defaultRepo。`)
}

/** 白名单 = repos 内（含子目录）或命中 patterns。 */
export function assertAllowed(repo, config, exec) {
  if (allowedRoots(config, exec).some((root) => isInside(repo, root))) return
  if (config.patterns.some((pattern) => matchesPattern(repo, pattern, exec))) return
  const roots = allowedRoots(config, exec)
  const listed = roots.length > 0 ? roots.join(' / ') : '未配置'
  const extra = config.patterns.length > 0 ? `；patterns：${config.patterns.join(' , ')}` : ''
  throw new Error(`仓库不在允许清单内：${repo}（允许：${listed}${extra}；用插件配置 repos / patterns 扩大）`)
}

/** 把 glob 编译成正则：`**` 跨目录，`*` 与 `?` 不跨目录分隔符。 */
export function globToRegExp(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:[^/]+/)*'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '')
}

/**
 * 匹配一个仓库路径：相对 pattern 比对**相对会话工作区**的路径，绝对 pattern 比对绝对路径。
 * 只匹配仓库根本身，不做子路径穿透。
 */
export function matchesPattern(repoPath, pattern, exec) {
  const posix = (value) => value.split(path.sep).join('/')
  const trimmed = pattern.trim()
  if (trimmed === '') return false
  const expanded = expandHome(trimmed)
  const regexp = globToRegExp(posix(expanded))
  if (path.isAbsolute(expanded)) return regexp.test(posix(repoPath))
  const workspace = sessionRoot(exec)
  if (!workspace) return false
  const relative = path.relative(workspace, repoPath)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false
  return regexp.test(posix(relative === '' ? '.' : relative))
}

/** 每个路径都必须是仓库内的相对路径；去重但保持顺序。 */
export function validatePaths(repoRoot, rawPaths) {
  const seen = new Set()
  const result = []
  for (const raw of rawPaths) {
    if (!isNonEmpty(raw)) throw new Error('paths 里有空值。')
    if (path.isAbsolute(raw)) throw new Error(`paths 必须是仓库内相对路径：${raw}`)
    const absolute = realOrResolved(path.resolve(repoRoot, raw))
    if (!isInside(absolute, repoRoot)) throw new Error(`路径越出仓库：${raw}`)
    const key = process.platform === 'win32' ? raw.toLowerCase() : raw
    if (seen.has(key)) continue
    seen.add(key)
    result.push(raw)
  }
  return result
}
