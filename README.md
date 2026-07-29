# kimi-hud

[kimi-code](https://github.com/MoonshotAI/kimi-code) 的自定义状态栏脚本，风格参考 [claude-hud](https://github.com/jarrodwatts/claude-hud)。基于 kimi-code 0.30.0 引入的 `[status_line] command` 能力：TUI 把会话快照以 JSON 传给脚本的 stdin，脚本 stdout 的首行替换底栏第 1 行。

## 效果

```
~/Documents/Codex ⎇ main +2 ~1 | yolo | [K3 ● max] | 内存 47% (30G/64G) | 会话 in 9.2M out 68.0k | 周 24% (1d 18h) 5h 24% (1h 57m) | Kimi v0.30.0
```

底栏第 2 行始终是内置的 context 读数，不受影响。

## 显示内容（从左到右）

| 段 | 说明 |
| --- | --- |
| 目录 / git | 当前目录（home 显示为 `~`，最多保留末两级）；git 仓库内追加分支名与工作区统计：`+N`（绿，新增 = 未跟踪 + 已暂存新文件）、`~N`（黄，修改/删除/重命名），为零则不显示 |
| permission | 权限/计划模式：`manual`（暗）、`plan`（蓝）、`yolo`（黄）、`auto`（红） |
| 模型 | `[模型名 ● effort]`，如 `[K3 ● max]` |
| 内存 | 系统 RAM 占用：`内存 47% (30G/64G)`，百分比按阈值着色（绿 <60%、黄 <85%、红 ≥85%）；macOS 用 `vm_stat` 估算（total − free − inactive − speculative），其他平台退化为 `os.freemem` 近似 |
| 会话用量 | 本会话累计 token：`in`（青色）= 输入（含缓存读取），`out`（品红）= 输出，口径与 `/usage` 的 Session usage 一致 |
| 套餐用量 | `周` 与 `5h` 两条限额的已用百分比与重置倒计时，配色同进度条阈值（绿 <60%、黄 <85%、红 ≥85%）；数据来自托管版 `/usages` 接口 |
| 版本号 | kimi-code 版本，如 `Kimi v0.30.0` |

## 工作原理

- TUI 每秒最多执行一次脚本，单次上限 300ms；非零退出、空输出或超时会回退到内置布局（或 `[status_line] items` 配置）。
- stdin JSON 字段：`model`、`cwd`、`gitBranch`、`permissionMode`、`planMode`、`contextUsage`（0-1）、`contextTokens`、`maxContextTokens`、`sessionId`、`version`。
- thinking effort 不在 JSON 里。脚本通过 `sessionId` 定位会话 wire 文件（`~/.kimi-code/sessions/*/session_<id>/agents/main/wire.jsonl`），取最后一条 `llm.request` 记录的 `thinkingEffort`，最多只读文件尾部 2MB；读取失败时静默省略 effort。因此切换 effort 后要等下一次请求才更新。
- 会话用量也不在 JSON 里。脚本汇总该会话 `agents/*/wire.jsonl` 中全部 `usage.record` 事件：`input = inputOther + inputCacheRead + inputCacheCreation`，`output = output`，与 `/usage` 口径相同。wire 文件随会话无界增长，因此用 sidecar 缓存（`~/.kimi-code/statusline-session-usage-cache.json`）记录每个 wire 的字节偏移与累计值，每次渲染只读增量部分。
- 套餐用量需要网络请求，但状态栏不能阻塞：脚本只读本地缓存 `~/.kimi-code/statusline-usage-cache.json`；缓存超过 120 秒（或不存在/损坏）时，派生一个**分离子进程**（`--refresh-usage` 模式）在后台请求 `https://api.kimi.com/coding/v1/usages` 并写缓存，下一刷新周期自然显示新数据。该接口使用 kimi 登录时写入的 `~/.kimi-code/credentials/kimi-code.json` 中的 OAuth access token，仅本机读取，缓存文件权限 600。防风暴措施：跨进程锁文件（15 秒 mtime 过期）防止并发刷新；刷新失败写入负缓存（保留旧数据、仅更新抓取时间），避免每秒重复 fork；缓存一律临时文件 + rename 原子写入。

## 安装

要求：kimi-code ≥ 0.30.0、Node.js ≥ 18。

```bash
git clone https://github.com/lock-down/kimi-hud.git
chmod +x kimi-hud/statusline.mjs
```

在 `~/.kimi-code/tui.toml` 中加入（路径改为实际位置）：

```toml
[status_line]
Mac     command = "/path/to/kimi-hud/statusline.mjs"
Windows command = 'node PATH\.kimi-code\statusline.mjs'
# 可选：脚本失败时回退到这个内置槽位布局
items = [ "mode", "goal", "model", "tasks", "cwd", "git", "tips" ]
```

TUI 内运行 `/reload-tui` 生效。

## 已知限制

- 只渲染一行：kimi-code 只取 stdout 首行，无法做到 claude-hud 的多行 HUD。
- 费用（cost）与缓存命中（cache hit）在 payload 和会话数据中均无来源，未实现。
- 内存占用为系统级估算值，非 kimi-code 进程用量。
- 套餐用量仅适用于 kimi 托管账号（需要 `credentials/kimi-code.json` 中的 OAuth token）；access token 过期且 kimi 尚未刷新时，会短暂显示上一次缓存的数据。数据最长滞后约 120 秒（缓存周期）。
- 上下文窗口（Context window）按设计不显示——它已由底栏第 2 行的内置读数覆盖。
- effort 与会话用量依赖 wire 文件（`wire.jsonl`）的内部记录格式（JSONL、`usage.record` / `llm.request` 字段名）。该格式是 kimi-code 未公开的内部实现，未来版本若变更，这两段会静默退化为不显示（不影响其他段）。

## 安全说明

脚本只在本机读取 kimi 自己的凭据文件用于查询你的用量接口，不向任何第三方发送数据；除此之外的所有信息（git、内存、会话文件）均为本地读取。
