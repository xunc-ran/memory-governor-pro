# memory-governor-pro（中文版）

本仓库是 **一体化 OpenClaw 记忆工程**：在同一skill里同时提供 **长期记忆插件（memory-lancedb-pro）**、**日终/阈值治理 CLI（governor）**，以及 **随仓分发的自改进技能资源（bundled/self-improvement）**。  
部署时通常把本目录作为 **Cursor / OpenClaw 的 skill**（见根目录 `SKILL.md`），并在 `openclaw.json` 中启用同名插件入口。

**项目借鉴**：本仓库在设计与实现上 **借鉴并延续** 以下两个开源脉络，并在同一目录树内与 **governor 治理**、OpenClaw 合并注入等能力做了整合与扩展（不等同于官方上游的 1:1 镜像，以本仓代码与文档为准）。

1. **[CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)** — 长期记忆 LanceDB 插件、混合检索与 OpenClaw 集成思路；本仓 `package.json` 的 `repository` 字段仍指向该仓库，便于对照主线演进。  
2. **[pskoett/pskoett-ai-skills 内的 self-improvement 技能](https://github.com/pskoett/pskoett-ai-skills/tree/main/skills/self-improvement)** — 自改进工作流、`.learnings` 资产与脚本形态；本仓以 `bundled/self-improvement/` **随插件分发**，并与插件侧 LanceDB 提醒、`self_improvement_*` 工具链等深度集成。

---

## 1. 三部分分别做什么

| 部分 | 入口 / 配置 | 职责 |
|------|-------------|------|
| **插件** | `index.ts`、`openclaw.plugin.json` | 向量记忆、混合检索、`memory_*` 工具、自动抓取/召回、反思与自改进钩子、**合并注入**（召回 + 反思 + LanceDB 提醒）与跨源去重 |
| **Governor** | `config.json`、`src/index.ts`（Commander CLI） | 按日历日精炼会话、写入 **治理专用** LanceDB、轮转/归档会话 `jsonl`、审计与可选快照、内置网关心跳调度 |
| **自改进资源** | `bundled/self-improvement/` | `SKILL.md`、可选 OpenClaw `hooks`、`scripts`、`.learnings` 资产模板；与插件逻辑配合见 `INTEGRATION.md` |

---

## 2. 记忆与自改进数据落在哪里

- **主记忆库（会话里 agent 用的那份）**  
  - 配置：`openclaw.json` → `plugins.entries.memory-lancedb-pro.config.dbPath`（未写则用插件默认路径）。  
  - 内容：对话抽取的事实/偏好、`memory_store`、自动抓取、反思映射条目等。  
- **自改进「规则」条目（插件写的 SI 规则）**  
  - 存在 **主记忆库同一 Lance 表** 中，元数据带 **`opencl_si_rule: true`**、`si_entry_id`（如 `LRN-…`/`ERR-…`）、`si_implementation_status` 等。  
  - **不会**进入普通 `autoRecall` 注入（代码侧已过滤）。  
  - 工作区 **`.learnings/SI_IMPLEMENTATION_AUDIT.md`** 仅追加**审计行**（创建/升级 skill 等事件），**不是**规则正文存储源。  
  - `.learnings/LEARNINGS.md` 等若由模板新建，多为**说明占位**；历史填满的旧文件不会被插件清空。  
- **自我改进「提醒」固定行**  
  - 稳定 id 存于 LanceDB（缺则嵌入种子）；在 `before_prompt_build` 里与其它注入块一起做语义去重。  
- **治理记忆库**  
  - 配置：`config.json` → `lancedb.dbPath`（默认 `memory/lancedb-governor/{AGENT_ID}`）。  
  - 日终精炼、`context-pack` 治理侧查询等主要写这里。  

**切勿**把插件 `dbPath` 与治理 `lancedb.dbPath` 指到**同一目录**，以免争用与隔离失效。

---

## 3. 注入与上下文

- **`before_prompt_build`（priority 10）**：合并 **LanceDB 自改进提醒 + auto-recall + reflection**，再用与 `uniqueInjection` 一致的阈值做**段落级去重**；`autoRecall` 命中时返回的注入可标 `ephemeral`。  
- **Context flush（priority 9）**：按占用比例触发时写 `context-pack.md` 等（治理侧路径），与主链路的 `autoRecall` 共用窗口预算；需保证 **`openclaw.json` 里只有一个** 名称含 `memory`/`lancedb`/`recall` 的注入插件，否则单注入源校验会挡召回/flush。

---

## 4. 环境变量与部署要点

- 容器内建议在 **`docker-compose.yml`** 注入 `OPENCLAW_HOME`、`OPENCLAW_AGENT_ID`、嵌入/重排所用 **API Key**（如 `JINA_API_KEY`），再在挂载的 `openclaw.json` 里用 `${VAR}` 引用。  
- Linux：`export OPENCLAW_HOME=~/.openclaw`（或实际数据目录）。  
- Windows PowerShell：`$env:OPENCLAW_HOME="$env:USERPROFILE\.openclaw"` 等。  

本目录安装依赖：

```bash
cd /path/to/memory-governor-pro
npm install
```

---

## 5. `openclaw.json` 插件配置示例（Jina 嵌入 + 重排）

```json
{
  "plugins": {
    "slots": { "memory": "memory-lancedb-pro" },
    "entries": {
      "memory-lancedb-pro": {
        "enabled": true,
        "config": {
          "embedding": {
            "provider": "openai-compatible",
            "apiKey": "${JINA_API_KEY}",
            "baseURL": "https://api.jina.ai/v1",
            "model": "jina-embeddings-v3"
          },
          "retrieval": {
            "mode": "hybrid",
            "rerank": "cross-encoder",
            "rerankProvider": "jina",
            "rerankApiKey": "${JINA_API_KEY}",
            "rerankEndpoint": "https://api.jina.ai/v1/rerank",
            "rerankModel": "jina-reranker-v2-base-multilingual"
          },
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

更完整的键与默认值以 **`openclaw.plugin.json`** 的 `configSchema` 为准。

---

## 6. 启动与自测

```bash
openclaw config validate
openclaw gateway restart
openclaw plugins info memory-lancedb-pro
```

---

## 7. CLI 一览

### 7.1 `openclaw memory-pro`（插件自带）

```bash
openclaw memory-pro list
openclaw memory-pro search "关键词"
openclaw memory-pro stats
openclaw memory-pro export --output memories.json
openclaw memory-pro import memories.json
```

### 7.2 Governor（`package.json` scripts，在本仓库目录执行）

| 命令 | 说明 |
|------|------|
| `npm run governor:daily-rotate` | 推荐：按配置时区处理「昨夜」+ 可补跑欠账；`--all-agents` 处理多 agent |
| `npm run governor:nightly` | 单日 `rotate` |
| `npm run governor:bootstrap` | 历史回填 |
| `npm run governor:flush` | 阈值 context-pack |
| `npm run governor:governance` | 生命周期治理 |
| `npm run governor:vendor:init-self-improving` | 从仓内 `bundled/self-improvement/assets` 拷贝 `.learnings` 样板（含审计文件） |
| `npm run governor:vendor:status` | 打印本机解析到的插件根与 bundled 路径 |
| `npm run governor:audit-inspect` / `audit-restore` / `audit-clear-rotation` / `audit-purge-memories` / `archive-prune` | 审计、回滚、治理库按日清理、归档 TTL |

内置调度：`config.json` 里 `internalScheduler.enabled`；可用环境变量 `MEMORY_GOVERNOR_DISABLE_INTERNAL_SCHEDULER=1` 关闭。Windows 可配合 `scripts/install-windows-daily-rotate-task.ps1`。

---

## 8. 重要文件（按职责）

| 路径 | 说明 |
|------|------|
| `index.ts` | OpenClaw 插件：hook、合并注入、反思、自改进、服务等 |
| `cli.ts` | `memory-pro` 子命令 |
| `openclaw.plugin.json` | 插件 id、版本、**配置 Schema** |
| `config.json` | Governor：会话根、状态目录、治理 LanceDB、调度、context flush、`rotation`/`governance` |
| `src/` | Store、检索、嵌入、工具、治理子模块、`self-improvement/*`、`lib/*` |
| `bundled/self-improvement/` | 自改进 SKILL、hooks、`scripts`、assets（含 `SI_IMPLEMENTATION_AUDIT.md` 模板） |
| `scripts/` | 同步版本、维护、技能测试、计划任务安装等 |

---

## 9. 兼容与版本

- **OpenClaw**：建议与当前宿主发行说明一致（如 `2026.x`）。  
- **系统**：Linux / Windows；容器需保证 `OPENCLAW_HOME` 与卷一致。  
- **注入**：统一走 `before_prompt_build` 新架构。

---

## 10. 常见问题

- **没有记忆注入**：查 `autoRecall`、memory slot、`dbPath`、嵌入 API。  
- **双份自改进提醒**：若额外启用了 `bundled/.../hooks/openclaw` 虚拟文件注入，与插件 LanceDB 提醒会重复——择一，见 `bundled/self-improvement/INTEGRATION.md`。  
- **Jina 401**：确认环境变量注入到网关进程。  
- **治理与主库串了**：核对两处 `*dbPath` 必须不同目录。

---

## 许可证

MIT
