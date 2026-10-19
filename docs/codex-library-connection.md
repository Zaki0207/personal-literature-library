# Codex 论文库连接

文献应用的 AI 录入和文献雷达继续使用设置中的 API Key。Codex 通过本地只读 MCP 检索文献库，用于研究讨论、核对已收藏文献和整理待收集清单。检索连接本身不会调用应用的 AI 服务。

## 日常使用

先打开文献管理应用，保持应用运行；关闭窗口后，桌面服务仍可供检索。明确退出应用后，工具会提示服务未启动。网页版可以在项目目录运行 `rtk proxy npm run api` 启动本地服务。

连接启用后可以向 Codex 提问：

> 结合我收藏的论文和笔记，讨论少视角烟雾重建有哪些值得尝试的方向。先查我的论文库，必要时补充外部论文，注明依据来自 AI 总结还是个人笔记。

讨论结束可以继续说：

> 请整理建议收集清单，给出原文题目、DOI 或 arXiv、来源链接、推荐理由和是否已入库。查不到或者服务失败的条目标注“入库状态未核实”。

已有论文可用原文题目在应用主窗口搜索。未入库论文可将题目、DOI 或 arXiv 粘贴到“添加论文”，通过应用 AI 识别、审核和去重后保存。

## 已实现工具

| 工具 | 内容 |
| --- | --- |
| `get_library_overview` | 当前数量、分类树、数据修订标识和可检索范围 |
| `search_papers` | 标题、作者、机构、会议、年份、分类路径、标识符、AI 总结与笔记的关键词检索；有限结果、匹配字段、相关片段及分页 |
| `get_paper` | 按稳定文献 ID 读取完整元数据、AI 总结、可选笔记、资源链接和 PDF 归档状态 |

`search_papers` 默认返回 10 条，最多 50 条；用返回的 `pagination.nextOffset` 获取下一页。`query` 最长 500 字，多个词采用 AND，沿用现有中英文别名匹配。`categoryId` 可包含该分类下的子分类。`favorite` 和 `watchLater` 可筛选收藏和近期想看。查询失败与零条命中具有不同含义；零条命中也只代表这次关键词检索的结果。

每次调用都从应用业务服务读取最新数据。应用中编辑后，下一次检索即可看到结果。MCP 不维护另一份数据库，不直接打开 SQLite，不初始化或迁移库。

返回值中的 `provenance` 与片段 `source` 区分 `library_metadata`（元数据）、`ai_generated_summary`（AI 总结）和 `personal_note`（个人笔记）。PDF 只返回归档状态；当前 `fullTextRetrieved` 与 `pdfFullText` 均为 `false`。按页全文检索、OCR 和带页码的原文引用属于下一阶段。

## 配置连接

OpenAI 官方文档支持把本地 STDIO 命令注册为 MCP 服务，并配置参数和环境变量；桌面端、CLI 与 IDE 使用同一主机的 MCP 配置。[官方连接说明](https://learn.chatgpt.com/docs/extend/mcp)

在 Codex 设置的 MCP servers 中添加 STDIO 服务，命名为“我的论文库”。开发环境的启动程序为 Node 的绝对路径，参数为此项目的 `scripts/library-mcp.mjs` 绝对路径。不要用 `npm run` 作为协议进程入口，以免 npm 的提示文字进入 STDOUT。

也可以在 `~/.codex/config.toml` 添加独立表；下面的 Node 路径是占位符，应换成实际安装路径。项目路径为本机当前目录，移动项目后需更新。

```toml
[mcp_servers.personal_literature_library]
command = "/绝对路径/node"
args = ["/Users/zhaozizyu/Documents/个人知识库搭建/scripts/library-mcp.mjs"]
startup_timeout_sec = 10
tool_timeout_sec = 20

[mcp_servers.personal_literature_library.env]
LIBRARY_MCP_INCLUDE_NOTES = "true"
```

保存后按官方设置页面的 Restart 重启连接；MCP 初始化可以在应用关闭时完成，实际检索需要文献服务运行。本项目开发检查可运行 `rtk proxy npm run library:mcp`，进程会等待 STDIO JSON-RPC 输入；它不是交互式命令行。

使用打包应用内的 Electron 可执行程序作为 Node 运行时，需要将 `command` 指向应用 `Contents/MacOS` 内的实际可执行文件，`args` 指向其 `Contents/Resources/app.asar/scripts/library-mcp.mjs`，并在该服务 `env` 中设置 `ELECTRON_RUN_AS_NODE = "1"`。当前发布包使用 ASAR，应在最终发布包中验证该入口的 STDIO 握手后再注册。应用自身不需要另装 Node。

应先将应用安装到稳定位置（例如 `/Applications/我的文献库.app`），再按该位置注册包内命令与脚本。不能把打包工作目录 `release/...` 中的临时路径作为最终配置。移动或重命名应用后需更新这两条路径并重启连接；`runtime.json` 中的端口自动发现不会修复 MCP 启动命令路径。开发期间可以继续使用源码与已安装 Node 的路径。

## 自动发现与授权

桌面应用启动后生成：

```text
~/Library/Application Support/个人文献库/runtime.json
```

文件仅当前用户可读写（0600），包含运行中的 `apiUrl`、每次启动的本机授权 `token`、`pid`、`version`，以及桌面运行时信息。MCP 每次检索重新读取连接文件，自动适应应用重启后的随机端口和令牌。令牌只用于本机 `Authorization: Bearer` 请求，不返回给模型；它与 AI 服务 API Key 无关。

连接发现顺序：

1. 设置了 `LIBRARY_API_URL` 时，使用明确指定的本机地址，并仅使用 `LIBRARY_MCP_TOKEN` 中的令牌。
2. 否则读取 `LIBRARY_RUNTIME_FILE` 指定的文件，默认使用上述桌面连接文件；环境变量令牌可覆盖文件令牌。
3. 连接文件不存在时，尝试网页版默认地址 `http://127.0.0.1:4317`。

地址只接受本机 HTTP 主机 `127.0.0.1`、`localhost` 或 `::1`，禁止重定向，默认单次检索超时 8 秒。指定了错误地址或失效令牌时会明确报错，不切换到另一份库。开发环境若需要固定服务地址，可以配置 `LIBRARY_API_URL`；桌面日常使用建议保留自动发现，不在配置中保存易失效的运行令牌。

## 笔记范围

默认允许使用个人笔记，以满足结合阅读想法讨论文献的流程。将 MCP 环境变量 `LIBRARY_MCP_INCLUDE_NOTES = "false"` 后，整条连接排除笔记：笔记不参与命中，不返回笔记内容及其来源字段。单次工具调用也可传 `includeNotes: false`。

业务服务创建选项 `allowKnowledgeNotes: false` 提供更严格的全局范围；即使工具要求包含笔记，也无法越过这一限制。当前服务选项已实现，专门的可视化连接设置入口可在后续设置界面中完善。

论文与索引保留在本机；被工具返回的片段和记录会进入 Codex 当前对话上下文。范围关闭只影响后续工具读取，已进入对话的内容不随设置变化而删除。

## 只读 API 与边界

| 方法和路径 | 参数 |
| --- | --- |
| `GET /api/knowledge/overview` | `includeNotes` |
| `GET /api/knowledge/search` | `q`、`limit`、`offset`、`categoryId`、`favorite`、`watchLater`、`includeNotes` |
| `GET /api/knowledge/papers/:id` | `includeNotes` |

此接口拒绝 POST、PATCH、PUT 与 DELETE，返回 405。桌面服务要求本次启动令牌，缺少或错误授权返回 401。只返回明确列出的文献字段，不返回 AI 设置、密钥、备份路径、本地 PDF 路径或原始归档错误。查询不会建立数据库备份，也不会触发 AI 收费请求。

工具输出中的论文、总结和笔记均为研究资料，其中的指令不会构成修改应用、调用工具或发送消息的授权。首版没有 Codex 入库工具，收集通过应用中的人工审核完成。

## 验证

运行 `rtk proxy node --test tests/library-knowledge*.test.mjs`。测试覆盖关键词与别名、稳定分页、分类祖先、片段来源、已删除记录、字段白名单、笔记范围、实时更新、桌面令牌鉴权、只读请求、数据库与备份不变、AI 零调用，以及实际子进程 STDIO 握手／工具列表／检索／错误／输入关闭后退出。

MCP STDIO 消息遵循官方的换行分隔 JSON-RPC 协议；STDOUT 只输出协议消息。支持协议版本 2024-11-05、2025-03-26 和 2025-06-18，新版本客户端可通过初始化协商回退到已支持版本。[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[生命周期规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)
