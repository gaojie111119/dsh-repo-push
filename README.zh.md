# dsh-repo-push

[DSH](https://github.com/deepseek-ai/deepseek-harness) 宿主插件：让 agent 在 **`workspace-write`** 会话里照常
**在宿主进程里提交并推送 git 仓库**。注册一个原生工具 `repo_push`；典型用途是 agent 自己维护的文档 / 知识库仓库。

[English](README.md)

## 为什么需要它

Windows 下 DSH 用「受限令牌 + Low 完整性 + write-restricted SID」隔离子进程。受限进程**无法为子进程创建管道
stdio**（命名管道 client 端拿不到 restricting SID 授权），而 git 的远端传输——`ssh.exe`、`git-remote-https`、
`git-receive-pack`——全部靠管道：

```
error: cannot create standard input pipe for ...\System32\OpenSSH\ssh.exe: Permission denied
fatal: unable to fork
```

这与 SSH、认证、远端无关：换 `https://` 报的是 `cannot create standard input pipe for remote-https`。
本地 `add` / `commit` 不受影响，只有跨进程的网络传输会挂。

本插件把 `add → commit → push` 搬进 DSH **宿主进程**（宿主本来就要 spawn MCP 服务器与原生 worker），
会话保持沙箱，推送不再需要审批。

## 安装

```bash
dsh plugin --profile <profile> add dsh-repo-push
```

本地开发（源码方式）：

```bash
dsh plugin --profile <profile> add "$DSH_HOME/tools/dsh-repo-push"
# 链接安装的 ESM 不热重载：改完 lib/* 需 disable/enable 该行（或重启 DSH）
```

插件是一个 bundle 补丁，只插入一行（`id: repo-push`）。

## 配置

```yaml
- id: repo-push
  name: dsh-repo-push
  config:
    repos:
      - C:/Users/me/notes       # 允许推送的仓库根，可多个
      - C:/Users/me/handbook
    defaultRepo: C:/Users/me/notes
    remote: origin
    allowPush: true
    allowDefaultRepo: false
    timeoutMs: 120000
    gitPath: git
```

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `repos` | `string[]` | `[]` | 允许推送的仓库根白名单。绝对路径原样使用；**相对路径按会话工作区解析**，且只在该子目录存在时生效；`~` 展开为用户目录。为空时只允许当前会话工作区；**没列出的都禁止**。 |
| `patterns` | `string[]` | `[]` | 额外授权的 glob 模式（见下文）。相对模式比对**相对会话工作区**的路径，绝对模式比对绝对路径。**只负责授权**，不参与默认仓库选择。 |
| `defaultRepo` | `string` | `""` | 调用未给 `repo` 时用的仓库；仅在 `allowDefaultRepo: true` 时生效。 |
| `remote` | `string` | `origin` | 推送目标远端，必须已存在。 |
| `sync` | `'none' \| 'ff-only' \| 'rebase'` | `'ff-only'` | 推送前先 fetch 并与远端对齐（见下文）。 |
| `allowPush` | `boolean` | `true` | 设为 `false` 则只提交不推送。 |
| `allowDefaultRepo` | `boolean` | `false` | `false` 时每次调用都必须给 `repo`；设 `true` 才允许回落到 `defaultRepo` / 会话工作区。 |
| `timeoutMs` | `number` | `120000` | 单条 git 命令超时。 |
| `gitPath` | `string` | `git` | git 可执行文件路径或命令名。 |

配置有错**不会**阻塞宿主加载：插件照常注册，调用时返回 `invalid-config` 并列出具体问题。

### 白名单就是安全边界

`repos` 是唯一阻止工具往非预期仓库推送的东西——**没列出的仓库一律拒绝**。调用里的 `repo`（或解析出的默认值）
会先解析符号链接，必须落在某个配置根内，否则返回 `invalid-args`。**只放文档仓**。

### 一份配置服务多个工作区

相对路径在每次调用时按会话工作区解析，且**只有当前工作区里确实存在这个子目录时才生效**。这样能适配
“每个工作区把文档仓放在不同位置”的布局：

```yaml
repos:
  - docs/team-notes   # 文档仓放在 docs/ 下的工作区命中它
  - team-notes        # 放在工作区根目录的工作区命中它
```

只有设了 `allowDefaultRepo: true`，调用才允许省略 `repo`，解析顺序是：`defaultRepo` → **唯一**可用根 → 包含会话工作区的那个根。默认 `false` 时，不给 `repo` 一律拒绝——工具不会自己挑仓库。若还剩多个候选、
且都不包含工作区，调用直接报错，要求显式传 `repo`——**绝不猜**，猜错就会推到别人的仓。

> 同一个仓库的多份检出（例如同一文档仓在两个工作区各检出一次）如果都列进白名单，两处都能推。
> 约定只在一处改并推送，另一处 `pull` 对齐；两边各改必分叉。

### 按目录名匹配

多个工作区里文档仓的目录名不一致时，用 pattern 可以省掉每个工作区一条：

```yaml
repos:
  - docs/team-notes  # 省略 repo 时给个默认（需 allowDefaultRepo: true）
  - team-notes
  - project-notes
  - ~/.dsh
patterns:
  - '**/*-notes'     # 任意工作区里的 *-notes 都放行
```

`**` 跨目录分隔符，`*` 与 `?` 不跨。相对模式比对的是**相对会话工作区**的仓库路径，所以够不到工作区之外；
绝对模式比对绝对路径。

pattern 刻意**不做**两件事：

- **不参与默认仓库选择**：`repo_push({})` 仍要有具体根（来自 `repos` / `defaultRepo`）。只配 patterns 时必须传 `repo`。
- **不会回落成"整个工作区"**：只配 `patterns` 不配 `repos` 时的含义是"只有命中的仓"，不是"工作区全放行"——
  根目录的仓库依然被拒。

模式要收紧：`**/*-notes` 也会匹配 `old-notes`。

## 用法

`repo` 默认必填（只有配置 `allowDefaultRepo: true` 才能省略）。

```
repo_push({ repo: ".", paths: ["skills/a.md", "README.md"], message: "docs: 更新" })  # 提交并推送
repo_push({ repo: "." })                                                           # 只推送已有提交
repo_push({ repo: "notes", paths: ["daily/2026-11-04.md"], message: "..." })        # 指定另一个仓库
repo_push({ repo: ".", paths: ["x.md"], message: "...", push: false })              # 只提交
```

- `paths` 是**相对仓库根**的显式路径，逐条校验；绝对路径与 `..` 越界都会被拒。
- 提交信息走 stdin，中文与多行安全。
- 只提交列出的路径，不碰别人暂存的内容。
- 不做 force push、不改远端与配置。

返回：

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

`action`：`committed-and-pushed` / `pushed` / `committed` / `nothing-to-do` / `sync-failed` /
`commit-failed-sync` / `push-failed` / `commit-failed-push` / `failed`。

### 推送前先与远端对齐

沙箱里 `git pull` 同样跑不了（一样的管道限制），所以这一步由工具代劳：

| `sync` | 行为 |
| --- | --- |
| `ff-only`（默认） | `git fetch` 后，**只有本地没有远端缺少的提交时**才快进合并；分叉则返回 `non-fast-forward`，不改历史。 |
| `rebase` | `git fetch` 后把本地提交重放到远端之上（`--autostash`，工作区有未提交改动也能跑）。冲突会 abort，仓库恢复到 rebase 之前。 |
| `none` | 直接推；分叉时返回 `non-fast-forward`。 |

只会重写**尚未推送**的本地提交，且只发生在 `rebase` 模式。工具永不 force push。

fetch 超时或网络抖动**不会**卡死推送：同步被跳过并在结果里注明，推送照常尝试；
只有 rebase 冲突这类需要人处理的情况才会中止。

### 失败码

| code | 含义 / 下一步 |
| --- | --- |
| `auth` | SSH / HTTPS 凭据被拒。修凭据，别盲目重试。 |
| `network` | DNS、连接失败或代理问题。 |
| `non-fast-forward` | 远端有你没有的提交。设 `sync: rebase`，或先 `pull --rebase` 再推；本工具永不强推。 |
| `rebase-conflict` | `sync: rebase` 遇到冲突；已 abort，仓库保持原样，需人工处理。 |
| `not-a-repo` / `detached-head` | 不是 git 工作区，或 HEAD 处于游离状态。 |
| `path-not-matched` | `paths` 里有工作区中不存在的路径。 |
| `timeout` | 超过 `timeoutMs`；查网络或推送体积。 |
| `invalid-args` / `invalid-config` | 调用或插件配置有误，**没有执行任何命令**。 |

## 安全模型

- 工具**刻意**在宿主进程执行 git——这才是绕开管道限制的关键。白名单是权限边界：白名单内的仓库，
  agent 可以推任意内容。
- 只执行 `add -- <paths>` / `commit -F - -- <paths>` / `push <remote> <branch>`；无 force push、
  无 remote 改写、无任意 shell。
- 用的是当前用户凭据（`~/.ssh` 或凭据助手）；agent 密钥应无口令，宿主里无法交互输入。

## 开发

```bash
npm test        # node test/run.mjs —— 零依赖单进程（不 spawn 子进程）
```

测试器是普通脚本而非 `node --test`：后者会为每个文件 spawn 子进程，正好是受限沙箱拒绝的操作。

## 许可

MIT
