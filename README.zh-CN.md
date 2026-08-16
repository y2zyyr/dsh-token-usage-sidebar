# dsh-token-usage-sidebar

[English](README.md) | 简体中文

这是一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web Profile 的社区插件，在侧边栏显示由 provider/runtime 上报并持久化保存的 Token 用量，并在原生设置中提供完整的 **Token 用量** 页面。

```text
TOKEN USAGE
Today       今日
Yesterday   昨日
Total       累计
```

这是社区插件，并非 DeepSeek 官方插件。

## 功能

- 侧边栏显示今日、昨日和累计 Token 用量。
- 在 **设置 → Token 用量** 中提供独立页面，位置在 Agent 预设之后、插件市场之前。
- 固定概览卡片：全部时间、今天、昨天、最近 7 天。
- 明细支持今天、昨天、7 天、全部时间四种范围。
- 显示输入、输出、缓存读取、缓存写入、推理、调用次数。
- 按供应商/模型汇总（按总量排序），并始终展示最近 7 个本地自然日（包含零值日期）。
- 本地持久化统计；重启 DSH 后不会归零。
- 关停安全持久化：在 store 关闭前先冲刷脏数据，快速重启 DSH 也不会丢失最新用量。
- 在存在权威会话用量记录时恢复历史用量，并如实报告扫描/覆盖状态（部分或失败的扫描绝不会声称完整的生命周期覆盖）。
- 对重放和重复事件去重，同一次调用只计入一次。
- 原生显示在 DSH Web 侧边栏。

![Token 用量设置页](docs/screenshots/token-usage-settings-v1.0.0.jpeg)

## 安装

### 让 Agent 安装（推荐）

将下面这段话直接发送给能够访问你本机 DSH 的 Agent：

```text
请根据 https://github.com/y2zyyr/dsh-token-usage-sidebar ，将这个插件安装到 DeepSeek Harness 的 web profile。
```

授权 Agent 安装第三方插件前，请先审阅源码；如需可复现的依赖版本，请固定到具体 commit。

### 手动安装

在 DSH 的 `web` profile 中从 GitHub 安装，然后重启 DSH：

```bash
dsh plugin --profile web add github:y2zyyr/dsh-token-usage-sidebar
# 安装后重启 `dsh web`。
```

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

插件使用 provider/runtime 上报的用量记录，而不是 tokenizer 估算值。总计为 `输入 + 缓存读取 + 缓存写入 + 输出`；**推理**只是输出的细分展示，绝不会再次加到总计。最终提交消息中的 `message.source.provider/model` 用于模型归属。

所有按日范围均使用 DSH 主机本地自然日；最近 7 天包含今天和此前 6 天。设置页只请求聚合结果，不会把逐调用账本发送到浏览器。

### 迁移与历史覆盖

v1.0.0/v1.0.1 会对可恢复的 DSH 持久会话事件做一次幂等重放，为已有调用补齐精确 buckets 和模型元数据。已有调用只会被补充信息，或被更高 seq 的最终消息替换，不会重复增加累计用量。

少量旧调用可能只有可靠的全部时间总计，无法再恢复日期、类别、供应商或模型。它们仍包含在全部时间中，并以“未分类覆盖”明确显示；插件不会伪造日期或模型归属。

**历史报告如实（v1.0.1）。** 插件区分两个不同信号：

- **来源扫描状态** —— 插件能枚举到的每个 session 是否都读取成功（complete / partial / failed / unknown）。只要有 session 读取失败，扫描状态就降为 partial，绝不能声称 complete。
- **历史覆盖** —— 是否能断言已恢复的记录代表了插件的完整生命周期历史（complete / partial / unknown）。因为枚举今天的 session 日志并不能证明不存在更早、已删除或超出窗口的 session，所以覆盖状态通常始终为 partial（无可恢复内容时为 unknown）。插件绝不会因为“找到了一些 session”就把扫描标记为完整。

**Total 的含义：** 生命周期 **Total** 是插件从持久化来源恢复的全部权威用量记录，加上开始追踪后记录的用量的去重并集——它反映的是插件可恢复的内容，而不是在无法证明完整历史时对 DSH 账户完整生命周期用量的断言。

## 数据与隐私

用量统计保留在本机 DSH runtime 中。GitHub 源码仓库不会接收、包含或上传你的 Token 账本；运行时持久化数据与源码和发布产物相互独立。

为了得到可靠的累计数据，插件仅保存必要的统计元数据，例如去重标识、日期桶和 Token 总数。其账本不保存提示词、助手文本、工具输出、API Key、凭据或对话内容。

## 兼容性与状态

当前插件版本：v1.0.1。

已验证 DeepSeek Harness `0.1.0-rc.6` 的 `web` profile；未声明更广泛的 DSH 版本或操作系统兼容性。已在本地观察到其运行于更新版本的桌面端（如 DSH Desktop 2.0.0），但不做正式声明。

### 可靠性保证（v1.0.1）

- **关停不丢写。** 在 store 关闭前先冲刷脏数据；持久化写入被串行化，并发保存不会竞争或乱序，瞬时写入失败也会把数据保留以供后续 flush 或 close 重试。
- **存储损坏时不静默归零。** 若持久化账本校验失败，插件会告警、不会覆盖损坏的来源数据，也绝不会静默地把 Total 显示为 0。
- **来源拆分不变量。** 实时/历史拆分会从权威记录重新计算，保证 lifetimeTotal = live + historical 始终成立。
- **如实报告历史。** 参见“迁移与历史覆盖”；部分或失败的扫描绝不会被错误标记为 complete。

## 开发

```bash
npm install
npm test
npm run build
```

`npm test` 运行用量统计、历史恢复与洞察测试；`npm run build` 将发布用的 host 和 browser bundle 写入 `lib/`，并保持根目录 `client.js` 与 `lib/client.js` 字节一致。GitHub Actions CI（`.github/workflows/ci.yml`）会执行 `npm ci`、`npm test`、`npm run build` 以及 `git diff --exit-code`，确保已提交的产物始终与源码一致。

## 许可证

[MIT](LICENSE)
