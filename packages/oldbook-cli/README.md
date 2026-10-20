# 脚本入口

这个模块只负责命令行编排；可复用逻辑和测试放在相邻的 `oldbook-core/`。
通用流程不绑定《疑雨集注》，书名和具体案例只出现在样本、任务或回归数据中。

## 冻结认可数据

将指定页范围的原图、OCR 原始产物、最终结构、历史与 AI 概览复制成不可覆盖的数据集，并生成 OCR 到最终文本的双向连接：

```powershell
npm run dataset:freeze -- --project <project-id> --id <dataset-id> --from 1 --to 42 --results paddleocr-vl,pp-ocrv6 --approval "人工认可原话" --actor human
```

冻结后用哈希清单检查文件是否被改动：

```powershell
npm run dataset:verify -- --project <project-id> --id <dataset-id>
```

数据集目录位于 `data/projects/<project-id>/datasets/<dataset-id>/`。相同 ID 不允许再次冻结；需要更新时使用新的版本 ID。

```text
packages/oldbook-cli/
  src/ebook.mjs          generate / evaluate / apply
  src/history.mjs        保留日志入口及 AGENTS.md 协议
  src/ocr/               PDF 拆页、OCR 调用、项目转换、导出、完整性检查
  src/maintenance/       一次性旧结构迁移，不用于日常修诗
  src/samples/           指定照片的复现实验
  examples/              可修改的任务规格模板
  test/ocr/              Python 离线测试
packages/oldbook-core/
  src/ebook-review.mjs   任务、双 OCR 证据、模型候选、应用保护
  src/ebook-evaluation.mjs
                         独立校验器，不调用模型
  test/cases/            按书区分的回归断言，不进入生成提示词
```

## 反馈到候选

### TXT 参考文档与单次修订

`reference.mjs` 将本地 TXT 按题名、组诗和逐首正文拆成 `references/yiyuji-txt.json`，并为第 43 页后的诗歌生成 `match-plan-from-43.json`。每条匹配保存来源行号、参考作品 ID 和相似分数；低分匹配仅是线索。两份 JSON 都位于被 Git 忽略的项目数据目录。命令示例：

```powershell
node packages/oldbook-cli/src/reference.mjs --project yiyuji-four-volumes --input "C:\path\to\疑雨集.txt"
```

弹窗提供“单次修订”和“直接覆盖”。前者明确记录本轮只调用一次模型；后者在候选生成后按候选哈希自动批准并写入正式电子书。参考文档会以单独的“参考文档”段落进入提示词，原页、人工校订和 OCR 仍用于判断异文。CLI 任务也可指定 `revision_mode: "single_revision"`、`apply_mode: "direct_overwrite"` 和 `reference_verses`；直接覆盖沿用候选批准记录和基线哈希检查。

本项目卷二第 131–198 页原先缺少结构化作品。`fill-reference-gap.mjs` 用 TXT 作品顺序与双 OCR 诗句重合度生成页码对齐报告；先不带参数预览，核对后加 `--apply` 作为候选批准补录。随后重新运行 `reference.mjs` 更新匹配计划，再用以下命令按作品批量修订。进度及每首对应的模型运行、批准运行都保存在 Git 忽略的 `references/revision-progress-from-43.json` 中，可中断续跑。

```powershell
node packages/oldbook-cli/src/fill-reference-gap.mjs
node packages/oldbook-cli/src/fill-reference-gap.mjs --apply
node packages/oldbook-cli/src/batch-revise.mjs --project yiyuji-four-volumes --from-page 43 --parallel 3
node packages/oldbook-cli/src/normalize-reference-script.mjs
node packages/oldbook-cli/src/normalize-reference-script.mjs --apply
node packages/oldbook-cli/src/verify-reference-revisions.mjs --project yiyuji-four-volumes --from-page 43
```

`batch-revise.mjs` 按匹配计划逐首处理，每首建立一条模型运行和自动批准记录，进度写入忽略的 `revision-progress-from-43.json`，可断点继续。它会向配置的模型服务发送目标条目、相邻页双 OCR 和匹配的参考诗句，运行前需确认这些资料可发送到该服务。

```powershell
node packages/oldbook-cli/src/batch-revise.mjs --project yiyuji-four-volumes --limit 1
node packages/oldbook-cli/src/batch-revise.mjs --project yiyuji-four-volumes
```

当前唯一生产路线是 `single-pass-v1 -> SKILL 复核 -> approve`。
`classic-poetry-v1` 和 `tri-pass-regions-v1` 已废弃，只保留历史代码和测试用于解释旧运行，不接受新任务。

1. Codex 对照原页和双 OCR 分析反馈，先修改实际执行的提示词、任务逻辑、校验器或回归测试。
2. 编写任务 JSON：明确 `scope`、`category`、连续且按正文顺序排列的 `entry_ids`、`result_ids` 和提炼后的 `rules`。
3. `generate` 只调用一次外部模型，只保存候选；不覆盖正式电子书。
4. `evaluate` 离线评估，检查差异和未决问题；需要继续时先改规则，再用 `--previous` 接续，最多三轮。
5. 用户明确批准具体候选后，才运行 `approve`（`apply` 是兼容别名）。校验问题作为警示随候选展示，不阻断批准；三轮失败保留候选，不自动转为 Codex 手修。

`examples/poetry-review.task.json` 是模板，运行前换成实际目标条目。
`entry_ids` 是局部修订范围，不是强制保留的作品边界；`structure` 模式允许范围内拆分、合并。
要找回整首漏诗，应把它前后的现有条目一起纳入目标范围，否则只读上下文不能补进正文。
新页初稿尚未批准时，可在任务中设置 `base_candidate_run_id`，直接复核该候选中的 `entry_ids`；
后续分段复核再引用上一段候选，最终只批准最后一个候选，避免把未复核初稿提前写入正式 JSON。

任务模式：

| mode | 用途 | 允许变化 |
| --- | --- | --- |
| `structure` | 作品边界、组诗、漏句、注文归属等 | 范围内结构和文字，语义仍须人工核对来源 |
| `notes` | 注文句读 | 仅 `notes[].text` 标点和空白，字符、顺序、锚点不变 |
| `prose` | 序跋、传记的文言句读 | 仅 `prose` 标点和分段，字符不变 |

生成读取所选每套 OCR 的校订文本；空校订不会回退为原始 OCR。目标页前后各带一页只读上下文，
保留独立模型来源、区域顺序、坐标和图像路径。当前 DeepSeek 请求是文本输入，图像路径是溯源引用，
不代表模型实际看过原图；图像判读仍由人工或 Codex 在任务准备阶段完成。
原始反馈只存档，调用时仅发送经提炼的规则。未带批准状态的 `AI_CONTEXT.md` 只记录版本，不作为模型真值输入。

```powershell
# 无网络、无项目写入
node packages/oldbook-cli/src/ebook.mjs --help
npm test
npm run test:ocr

# 配好 .env.local 的硅基流动接口后，用户授权才运行
npm run ebook:generate -- --project <project-id> --task <task.json> --cases <cases.json>

# 查看日志目录内 output.json 的 candidate、diff、entry_order、evaluation、model_issues
npm run ebook:evaluate -- --project <project-id> --run <run-id> --cases <cases.json>

# 检查失败原因、修改规则或代码后，再发起一轮（不是自动重试三次）
npm run ebook:generate -- --project <project-id> --task <task.json> --previous <run-id>

# 查看所有等待批准的候选，需先启动本地 API：npm run api
npm run ebook:candidates -- --project <project-id> --state awaiting_approval

# 仅明确批准后应用；Agent 代执行时必须如实记录 actor/channel/requested-by
node packages/oldbook-cli/src/ebook.mjs approve --project <project-id> --run <run-id> --approve <candidate-sha256> --note "用户批准的具体范围" --actor ai:codex --channel agent --requested-by human
```

`generate`/`evaluate` 不依赖本地 API；`apply` 通过默认 `http://127.0.0.1:3100` 的共享保存接口执行。
`--skill` 可指定技能文件位置；默认读取当前用户安装的 `oldbook-poetry-structuring/SKILL.md` 并记录内容哈希。
生成使用 `.env.local` / `.env` 中 `SILICONFLOW_API_KEY`、`SILICONFLOW_BASE_URL`、`SILICONFLOW_MODEL`，可用 `--model` 覆盖模型。
一次请求上限 12000 输出 token、超时 240 秒，无自动网络重试；超时或输出不完整记为失败并保留响应，不写正式数据。
处理长篇或密集注文时缩小条目范围，避免一次返回过长。

## 日志与验收

所有产物使用既有 `HistoryStore` 写入 `data/projects/<project-id>/history/runs/<run-id>/`：

- `manifest.json`：模型、轮次、父运行 ID、输入输出哈希。
- `input.json`：冻结的初始基线、双 OCR、只读上下文、任务、独立断言、实际消息和版本哈希。
- `steps/*.json`：实际请求与原始响应、失败、附加离线验收、用户批准。
- `output.json`：候选、基线/候选哈希、逐字段差异、条目顺序、验收、模型未决问题。

独立断言只供校验器使用，不进入生成模型请求。`model_issues` 单独保留在候选报告，不自动混入正式 `issues`。
同一轮的文件不可手工编辑；读取时检查哈希。一次只操作同一 run，勿并发向其追加日志。
续跑保留冻结的初始 OCR 和基线，并将前轮候选作为修订输入；已有断言不能删改，附加断言会沿用到下一轮。
新增回归断言也计入版本变化，但仍需先弄清失败原因，不应靠无关用例消耗三轮次数。
应用会重新执行初始和附加验收并把失败项保留为警示，同时检查候选哈希与正式基线，并与编辑器保存串行执行；生成进行中拒绝应用。
批准事件关联原生成 run，记录为人工批准 AI 候选，只有保存时间戳会在应用时更新。

机械验收覆盖结构、范围、页码、近体诗句数和字数、标点、格式化字符保真、注码越界及指定案例。
它不证明识字、题名或注释语义正确；即使全部通过也只标记 `needs_review`，不自动批准。
未覆盖的案例为 `not_exercised`，不能算通过。

`packages/oldbook-core/test/cases/yiyuji.json` 整理了咏史、无题、赠冯元甫、春晴、效元相体五组历史反馈断言，
全部为 `proposed`，尤其精确注码须复核原页后才能批准。当前正文可能已经修过：
在它上面通过只能证明未回归，不能证明新提示词修复了旧错误。比较提示词能力时，需要同一份冻结的错误输入，
保留每轮候选；不能用手工改好的正文作为生成结果再声称模型通过。

## 原脚本如何对应

- `punctuate_ebook_notes.mjs`：改为 `ebook.mjs generate` + `mode: notes`。
- `format_ebook_prose.mjs`：改为 `mode: prose`；不再另外维护 prefaces 别名。
- `revise_ebook_poetry.mjs`、`revise_ebook_focus.mjs`：统一为 `mode: structure` 的显式目标范围。
- `apply_yiyuji_ebook_review*.mjs`、`finalize_poetry_review.mjs`：删除硬编码改正文脚本，具体问题转为回归数据。
- 原 Python OCR 脚本移入 `ocr/`，已有 `project:*`、`volume:*`、`ocr:*` npm 命令名不变。
- `test_remote_results.py` 位于 `test/ocr/`，使用 `npm run test:ocr`。
- `migrate_note_positions.mjs` 移入 `maintenance/`，默认只预览；加 `--apply` 才写入并记录历史。
  这是旧字段兼容迁移，不能用来自动确定正确注码，执行前停 API 并备份。
- `migrate_projects.mjs` 移入 `maintenance/`，仍是会写入的旧数据迁移，需明确授权后单独执行。

首页的首次结构化、单页修订、CLI 和 MCP 都使用同一候选生命周期。`/ebook/run` 只生成候选；正式结果只能通过统一批准事务写入。
