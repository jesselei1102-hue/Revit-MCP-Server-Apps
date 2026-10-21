# 模型检查（03 Checks）与仪表盘（04 Dashboard）：设计规格

日期：2026-10-21
状态：待审阅
分支：`feature/ultraviolet-checks-dashboard`（界面 mockup 已提交：`b50fc44`）

## 1. 目标

在 Revit Schedule MCP App 中加入基于规则的模型检查：

- **03 Checks**：规则入口，支持导入 Model Checker 检查集 XML（如 IFC-SG），以及通过 Claude 创建规则；在 app 里查看、启停、微调规则；点击运行检查。
- **04 Dashboard**：只读展示最近一次检查的结果和历史趋势，内容包括构件情况、参数情况和修改建议。不与模型互动。

### 已确认的决定

| 问题 | 决定 |
|---|---|
| 目的 | 既支持 IFC-SG 等官方检查集，也支持自定义规则，两者在仪表盘统一展示 |
| 自定义规则的创建方式 | 主要通过 Claude 用自然语言创建；app 里可查看、启停和微调 |
| 结果保存 | 保存每次运行的摘要（用于趋势）和最近 10 次的明细 |
| 检查引擎位置 | 方案 A：放在 Node MCP 服务里（TypeScript），规则与结果存入现有 SQLite |
| 实施分期 | 一份规格、一份计划，分两期：第一期服务端，第二期界面 |

### 假设（已在讨论中确认，无异议）

- 只对主模型构件做合规判定；链接模型只在仪表盘里统计数量。
- 结果按 Revit 项目分开保存（文档标题加路径，对应现有 `projects` 表）。
- 修改建议由引擎按固定规则生成，可重复、可追溯，不由模型临时生成。

### 成功标准

1. 导入本机 `IFC-SG_ModelValidationChecks_v1.0.xml` 后得到 586 条规则、93 个分组，全部为"支持"状态。
2. 在 Snowdon Towers 示例模型上运行全部启用规则时，能在合理时间内完成（与打开完整表格相当，约几十秒）；单个类别取数失败不会导致整次运行失败。
3. 抽查结果准确：随机挑 3 个报"缺参数"的构件，在 Revit 中确认确实缺失；挑 3 个通过的构件，确认确实具备。
4. 我（Claude）根据一句自然语言描述创建的规则能通过校验、存入规则库，并在 03 中显示。
5. 04 在明暗主题下正确显示最近一次结果、最近 10 次趋势和排序后的修改建议；页面上没有会改动模型的操作。
6. 返回给模型的工具结果只含摘要，不再出现"结果过大"。

### 不在范围内

- 自动修复（应用建议并写回模型）：建议只给出文字和筛选指引，修改仍在 01 中完成。
- 规则的完整表单编辑器（只做启停、严重度、名称和建议文字的微调）。
- 链接模型的合规判定。
- 导出报告（PDF/Excel）。
- Model Checker XML 之外的规则格式（如 IDS）。

## 2. 架构

```
03 Checks（规则入口）            04 Dashboard（只读）
   │                                  ▲
   ▼                                  │
 MCP 工具（server/src/checks/tools.ts）
   rules_import_checkset · rules_upsert · rules_list · rules_set_enabled
   checks_run · checks_get_results
   │
   ├─ modelCheckerXml.ts  XML → 规则 JSON（纯函数）
   ├─ ruleFormat.ts       规则 JSON 格式 + zod 校验
   ├─ collector.ts        按启用规则采集所需类别和参数（query_model + get_element_data 分批）
   ├─ engine.ts           规则 + 构件数据 → 判定结果 + 建议（纯函数）
   └─ store.ts            SQLite 读写（revit-data.db）
```

- 所有新工具都不带界面（无 `_meta.ui`）；界面通过 `callServerTool` 调用，Claude 也可直接调用。
- 工具返回给模型的 `content` 只含摘要；界面需要的明细放在 `structuredContent`。
- 运行检查时，用文档标题和路径在 `projects` 表中查找或创建项目（通过 `send_code_to_revit` 读取文档信息，沿用现有仪表盘统计的做法）。
- 界面仍是同一个 Schedule app，标签页为 `01 Elements · 02 Changes · 03 Checks · 04 Dashboard`。04 的数据通过 `checks_get_results` 单独获取，不加入主查询。

## 3. 规则格式与判定语义

### 3.1 规则 JSON

```ts
type Rule = {
  id: string;                 // XML 的 Check ID，或新生成的 UUID
  rulesetId: string;
  group: string;              // XML 的 SectionName；自建规则可自定
  name: string;
  description?: string;
  severity: "error" | "warning" | "info";
  enabled: boolean;
  scope: {
    categories: string[];     // OST_ 枚举名
    elementKind: "instance" | "type" | "any";
    where: Condition[];       // 全部满足才在范围内（AND）
  };
  require: Condition[];       // 范围内每个构件必须全部满足，否则失败
  fix?: string;               // 建议模板，可用占位符 {param} {count} {category} {type}
  source: { kind: "model-checker-xml" | "claude" | "manual"; file?: string };
};
type Condition = { param: string; op: Op; value?: string; caseInsensitive?: boolean };
type Op = "defined" | "notDefined" | "hasValue" | "isEmpty" | "equals" | "notEquals"
        | "contains" | "matches" | "gt" | "lt";
```

条件语义：

| op | 成立条件 |
|---|---|
| defined / notDefined | 参数存在 / 不存在 |
| hasValue / isEmpty | 参数存在且非空 / 不存在或为空 |
| equals / notEquals / contains | 字符串比较（`caseInsensitive` 控制大小写） |
| matches | 正则匹配（无效正则在 `rules_upsert` 时即被拒绝） |
| gt / lt | 数值比较；参数值无法解析为数字时视为不成立 |

参数查找顺序：先查实例参数，查不到再查类型参数。

### 3.2 Model Checker XML 转换

IFC-SG 检查集只有两种结构，全部 `Operator="And"`：

1. **532 条 `ResultCondition="FailNoElements"`**：`Category Included` + `IfcExportAs Equal <类>` + `<参数> Defined True` + `Is Element Type Equal False`。
   转换为：`scope = {categories:[类别], elementKind:"instance", where:[IfcExportAs equals <类>]}`，`require = [<参数> defined]`。
2. **54 条 `ResultCondition="CountAndList"`**：`Category Included` + `Export to IFC As HasNoValue True`。
   转换为：`scope = {categories:[类别], elementKind:"any", where:[]}`，`require = [Export to IFC As hasValue]`。

其它结构（含 `Or` 运算、未知条件或未知过滤类别）的检查，导入时标记 `supported=false`、默认停用，并在 03 中列出原因。导入的规则默认严重度均为 `warning`，用户可在 03 中修改。

**语义差异（须在 04 上注明）**：Model Checker 对模式 1 的判定是"整组至少有一个构件满足即通过"；本引擎逐构件判定，每个范围内构件都必须满足，因此通过率会低于 Model Checker 的报告。

### 3.3 判定与建议

- 构件在范围内，当且仅当：类别在 `scope.categories` 中、类型/实例符合 `elementKind`、`where` 全部成立。
- 构件失败，当且仅当：在范围内，且 `require` 中任一条件不成立。
- 规则结果：范围内没有构件为 `n/a`；有失败构件为 `fail`；否则为 `pass`。数据采集失败的类别下的规则为 `n/a`，并附原因。
- 建议生成（按优先级）：
  1. `defined` 失败：建议把参数加入族或项目参数（在 01 中无法填写）。
  2. 失败构件中同一类型占多数（≥ 60%）：建议在该类型上统一修改，并给出数量。
  3. 其余情况：建议在 01 Elements 中批量填写，并给出类别和层的筛选提示。
  规则带 `fix` 模板时，优先使用模板。

## 4. 数据存储与工具

### 4.1 新增表（`revit-data.db`）

```
rulesets      id TEXT PK, name, source_kind, source_file, imported_at, enabled
rules         id TEXT PK, ruleset_id FK, grp, name, severity, enabled, supported, unsupported_reason,
              body TEXT(JSON), updated_at
check_runs    id INTEGER PK, project_id FK, started_at, finished_at, status(running|done|failed), error,
              elements_checked, rules_run, passed, failed, summary TEXT(JSON)
check_results run_id FK, rule_id, status(pass|fail|n/a), in_scope, failed_count,
              failed_ids TEXT(JSON，最多 500 个), by_type TEXT(JSON), fix TEXT, note TEXT
```

- `summary` 含：按规则集、分组、类别、严重度的计数，参数填写率，构件统计（主模型与链接模型数量）。
- 每个项目只保留最近 10 次运行的 `check_results`；更早的运行只保留 `check_runs` 行（用于趋势）。

### 4.2 工具

| 工具 | 输入 | 输出（content 摘要 / structuredContent） |
|---|---|---|
| `rules_import_checkset` | `path` 或 `xml`（二选一），可选 `name` | 新规则集的规则数、分组数、不支持数；同名规则集再次导入时整体替换 |
| `rules_upsert` | `rules: Rule[]`（`id` 缺省时生成） | 已保存数量；zod 校验失败时返回逐条错误 |
| `rules_list` | 可选 `rulesetId`、`group` | 规则集 → 分组 → 规则（含启用、支持状态、最近一次结果） |
| `rules_set_enabled` | `enabled` 加 `ids`、`rulesetId` 或 `group` 之一 | 受影响的规则数 |
| `checks_run` | 可选 `rulesetIds` | 运行 id 与摘要；运行中可用 `checks_get_results` 查询进度 |
| `checks_get_results` | 可选 `runId`（默认最近一次） | 状态与进度（运行中时）；完成后为仪表盘所需全部数据：摘要、按规则结果、建议（按影响构件数排序）、最近 10 次趋势、构件与参数统计 |

### 4.3 运行流程

1. `collector` 汇总启用规则涉及的类别，以及每个类别需要的参数（`where` 与 `require` 中出现的参数名）。
2. 按类别调用 `query_model` 取构件，再用 `get_element_data`（`SpecificParameters`，每批 100 个）取所需参数；同时取得每个构件的类型参数（见第 6 节风险 1）。
3. `engine` 判定，`store` 写入一次运行；运行中更新进度字段（已采集类别数、已判定规则数）。
4. 界面每秒查询一次 `checks_get_results` 显示进度，直到状态为 `done` 或 `failed`。

## 5. 界面

样式和交互以已提交的 mockup（`b50fc44`）为准；第二期把 `checks-mock.ts` 的示例数据替换为真实工具调用。

**03 Checks**
- 规则集卡片：名称、规则数、来源，总开关。
- 分组列表：规则数、上次结果（"N failing" / "all pass" / "off"），分组开关；分组可展开到单条规则（严重度、名称、建议文字可就地修改，调用 `rules_upsert`）。
- 不支持的规则单独列出，并显示原因。
- **import xml**：文件选择框读取 XML 文本 → `rules_import_checkset({xml})`。
- **ask claude ↗**：把"帮我创建规则：<描述>"通过 `app.sendMessage` 发到对话；宿主不支持时退回为复制到剪贴板并提示粘贴。规则建好后，03 在下次切换到该标签或点刷新时重新读取。

**04 Dashboard（只读）**
- 顶部：规则通过率（与上次对比）、最近 10 次趋势线；问题计数（错误、警告、缺 IFC 分类）。
- 构件：按类别显示主模型构件数和合规率；链接模型只显示数量。
- 参数：被规则要求的参数的填写率及涉及类别。
- 修改建议：按影响构件数排序，显示严重度、标题、来源规则和建议文字。
- 注明"逐构件判定，比 Model Checker 更严格"。
- 没有运行记录时显示空状态，引导到 03 运行检查。

**Dock**：01/02 为选择操作与 Apply；03/04 为 "N rules on · last run hh:mm" 与 **Run checks →**（运行中显示进度并禁用）。

**模型上下文**：增加当前标签页、最近一次运行的摘要和前 5 条建议。

## 6. 风险与应对

1. **类型参数取不到**：`get_element_data` 可能只返回实例参数。实施计划第一个任务即验证；不行则增加按类型 id 批量取参数的请求；再不行用固定的 `send_code_to_revit` 脚本读取类型参数。
2. **大模型耗时**：只采集用到的类别和参数；实测后如仍过慢，按分组分批运行并显示进度。
3. **结果与 Model Checker 不一致引起误解**：04 上注明判定语义差异。
4. **数据库膨胀**：只保留最近 10 次明细，`failed_ids` 每条规则最多 500 个。

## 7. 测试

- 服务端加入 vitest（与 Design Theme 模板一致）。
- `modelCheckerXml`：小型测试 XML 覆盖两种模式与一个不支持的结构；另有一条测试读取本机完整 IFC-SG 文件（不存在时跳过），断言 586 条规则、93 个分组、全部支持。
- `engine`：构造构件数据，覆盖全部条件、实例与类型参数的查找顺序、范围过滤、链接构件不判定、`n/a`、三类建议及模板替换。
- `store`：内存 SQLite，覆盖导入覆盖、启停、写入运行、只保留 10 次明细、趋势摘要。
- `collector`：模拟 Revit 客户端，覆盖只请求所需类别和参数、分批、类别失败时规则为 `n/a`。
- 界面：在模拟宿主测试页中加入规则与检查工具的模拟实现，明暗两种主题下逐项验证 03 和 04。
- 真实模型：在 Snowdon Towers 上用 IFC-SG 运行并按成功标准第 3 条抽查。

## 8. 分期

- **第一期（服务端）**：`ruleFormat`、`modelCheckerXml`、`engine`、`store`、`collector`、6 个工具及测试。完成后无需界面即可由 Claude 导入检查集、运行检查并汇总结果。
- **第二期（界面）**：03 与 04 接入真实工具，替换 `checks-mock.ts`；进度显示；`sendMessage` 建规则；模型上下文扩展。
