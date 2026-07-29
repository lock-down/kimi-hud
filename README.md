# kimi-hud

[kimi-code](https://github.com/MoonshotAI/kimi-code) 的自定义状态栏脚本，风格参考 [claude-hud](https://github.com/jarrodwatts/claude-hud)。基于 kimi-code 0.30.0 引入的 `[status_line] command` 能力：TUI 把会话快照以 JSON 传给脚本的 stdin，脚本 stdout 的首行替换底栏第 1 行。

## 效果

```
~/Documents/Codex ⎇ main +2 ~1 | yolo | [K3 ● max] | 内存 █████░░░░░ 47% (30G/64G) | Kimi v0.30.0
```

底栏第 2 行始终是内置的 context 读数，不受影响。

## 显示内容（从左到右）

| 段 | 说明 |
| --- | --- |
| 目录 / git | 当前目录（home 显示为 `~`，最多保留末两级）；git 仓库内追加分支名与工作区统计：`+N`（绿，新增 = 未跟踪 + 已暂存新文件）、`~N`（黄，修改/删除/重命名），为零则不显示 |
| permission | 权限/计划模式：`manual`（暗）、`plan`（蓝）、`yolo`（黄）、`auto`（红） |
| 模型 | `[模型名 ● effort]`，如 `[K3 ● max]` |
| 内存条 | 系统 RAM 占用进度条（绿 <60%、黄 <85%、红 ≥85%），macOS 用 `vm_stat` 估算（total − free − inactive − speculative），其他平台退化为 `os.freemem` 近似 |
| 版本号 | kimi-code 版本，如 `Kimi v0.30.0` |

## 工作原理

- TUI 每秒最多执行一次脚本，单次上限 300ms；非零退出、空输出或超时会回退到内置布局（或 `[status_line] items` 配置）。
- stdin JSON 字段：`model`、`cwd`、`gitBranch`、`permissionMode`、`planMode`、`contextUsage`（0-1）、`contextTokens`、`maxContextTokens`、`sessionId`、`version`。
- thinking effort 不在 JSON 里。脚本通过 `sessionId` 定位会话 wire 文件（`~/.kimi-code/sessions/*/session_<id>/agents/main/wire.jsonl`），取最后一条 `llm.request` 记录的 `thinkingEffort`，最多只读文件尾部 2MB；读取失败时静默省略 effort。因此切换 effort 后要等下一次请求才更新。

## 安装

要求：kimi-code ≥ 0.30.0、Node.js ≥ 18。

```bash
git clone https://github.com/lock-down/kimi-hud.git
chmod +x kimi-hud/statusline.mjs
```

在 `~/.kimi-code/tui.toml` 中加入（路径改为实际位置）：

```toml
[status_line]
command = "/path/to/kimi-hud/statusline.mjs"
# 可选：脚本失败时回退到这个内置槽位布局
items = [ "mode", "goal", "model", "tasks", "cwd", "git", "tips" ]
```

TUI 内运行 `/reload-tui` 生效。

## 已知限制

- 只渲染一行：kimi-code 只取 stdout 首行，无法做到 claude-hud 的多行 HUD。
- 费用（cost）与缓存命中（cache hit）在 payload 和会话数据中均无来源，未实现。
- 内存占用为系统级估算值，非 kimi-code 进程用量。
