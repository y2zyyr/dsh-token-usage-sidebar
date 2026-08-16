# dsh-token-usage-sidebar

English | [简体中文](#中文说明)

A community [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web-profile plugin that shows persistent provider-reported token usage in the sidebar:

```text
TOKEN USAGE
Today       …
Yesterday   …
Total       …
```

This is a community plugin, not an official DeepSeek plugin.

## Features

- Today, Yesterday, and lifetime Total token usage.
- Persistent local accounting that survives DSH restarts.
- Historical recovery from available authoritative session usage records.
- Replay-safe, deduplicated accounting: an invocation is counted once.
- Native placement in the DSH web sidebar.

## Installation

Install from GitHub into the DSH `web` profile, then restart DSH:

```bash
dsh plugin --profile web add github:y2zyyr/dsh-token-usage-sidebar
# Restart `dsh web` after installation.
```

Review third-party source before installing. Pin a commit when your workflow requires a reproducible dependency revision.

## Update

Update the installed plugin, then restart DSH:

```bash
dsh plugin --profile web update dsh-token-usage-sidebar
# Restart `dsh web` after updating.
```

## Removal

```bash
dsh plugin --profile web remove dsh-token-usage-sidebar
# Restart `dsh web` after removal.
```

Removing the plugin does not reset its separately persisted local accounting data.

## How it works

```text
DSH/provider usage records
        ↓
historical and live collection
        ↓
deduplication
        ↓
persistent local accounting
        ↓
sidebar summary
```

The plugin uses provider/runtime-reported usage records rather than tokenizer estimates. It treats the final committed usage record as authoritative, recovers known historical usage where available, and replaces duplicate/replayed samples instead of adding them again. Today and Yesterday use the host machine's local calendar days.

## Data & Privacy

Usage accounting stays local to the DSH runtime. The source repository does not receive, contain, or upload a user's token ledger. Runtime persistence is separate from the source code and release artifacts.

The plugin stores accounting metadata needed for reliable totals, such as deduplication identity, date bucket, and token totals. It does not persist prompts, assistant text, tool output, API keys, credentials, or conversation content as part of its ledger.

## Compatibility and Status

Current release: [v0.2.1](https://github.com/y2zyyr/dsh-token-usage-sidebar/releases/tag/v0.2.1).

Verified with DeepSeek Harness `0.1.0-rc.6` and its `web` profile. No broader DSH-version or operating-system compatibility is claimed.

## Development

```bash
npm install
npm test
npm run build
```

`npm test` runs the accounting and historical-recovery tests. `npm run build` writes the shipped host and browser bundles to `lib/`.

## License

[MIT](LICENSE)

---

# 中文说明

[English](#dsh-token-usage-sidebar) | 简体中文

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web Profile 的社区插件，在侧边栏显示由 provider/runtime 上报并持久化保存的 token 用量：

```text
TOKEN USAGE
Today       今日
Yesterday   昨日
Total       累计
```

这是社区插件，并非 DeepSeek 官方插件。

## 功能

- 显示今日、昨日和累计 token 用量。
- 本地持久化统计；重启 DSH 后不会归零。
- 在存在权威会话用量记录时恢复历史用量。
- 对重放和重复事件去重，同一次调用只计入一次。
- 原生显示在 DSH Web 侧边栏。

## 安装

在 DSH 的 `web` profile 中从 GitHub 安装，然后重启 DSH：

```bash
dsh plugin --profile web add github:y2zyyr/dsh-token-usage-sidebar
# 安装后重启 `dsh web`。
```

安装第三方插件前请先审阅源码；如需可复现的依赖版本，请固定到具体 commit。

## 更新

更新已安装的插件后重启 DSH：

```bash
dsh plugin --profile web update dsh-token-usage-sidebar
# 更新后重启 `dsh web`。
```

## 卸载

```bash
dsh plugin --profile web remove dsh-token-usage-sidebar
# 卸载后重启 `dsh web`。
```

卸载插件不会自动清空独立保存的本地用量统计。

## 工作方式

```text
DSH/provider 用量记录
        ↓
历史记录与实时记录采集
        ↓
去重
        ↓
本地持久化统计
        ↓
侧边栏摘要
```

插件使用 provider/runtime 上报的用量记录，而不是 tokenizer 估算值。最终提交的用量记录视为权威数据；能够读取的历史权威记录会被恢复。重复或重放的样本会被替换而不是累加。今日和昨日按主机本地日历日计算。

## 数据与隐私

用量统计保留在本机 DSH runtime 中。GitHub 源码仓库不会接收、包含或上传你的 token 账本；运行时持久化数据与源码和发布产物相互独立。

为了得到可靠的累计数据，插件仅保存必要的统计元数据，例如去重标识、日期桶和 token 总数。其账本不保存提示词、助手文本、工具输出、API Key、凭据或对话内容。

## 兼容性与状态

当前版本：[v0.2.1](https://github.com/y2zyyr/dsh-token-usage-sidebar/releases/tag/v0.2.1)。

已验证 DeepSeek Harness `0.1.0-rc.6` 的 `web` profile；未声明更广泛的 DSH 版本或操作系统兼容性。

## 开发

```bash
npm install
npm test
npm run build
```

`npm test` 运行用量统计与历史恢复测试；`npm run build` 将发布用的 host 和 browser bundle 写入 `lib/`。

## 许可证

[MIT](LICENSE)
