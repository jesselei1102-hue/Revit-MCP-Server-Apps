# 模型检查与仪表盘：实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 在 Revit MCP 服务中实现基于规则的模型检查（导入 Model Checker XML、Claude 建规则、运行检查、存储结果），并把 Schedule app 的 03 Checks 和 04 Dashboard 从示例数据接到真实结果。

**Architecture：** 服务端新增 `server/src/checks/` 模块：规则格式（zod）、XML 转换、判定引擎（纯函数）、SQLite 存储、数据采集（固定的只读 `send_code_to_revit` 脚本），以及 6 个无界面的 MCP 工具。界面通过 `callServerTool` 调用这些工具，替换 `checks-mock.ts`。

**Tech Stack：** TypeScript 5.8、Node ≥ 20、`@modelcontextprotocol/sdk`、`zod` ^3.24、`better-sqlite3` ^12.8（已有）、新增 `fast-xml-parser` ^4.5、新增开发依赖 `vitest` ^3.2.4。

**Spec：** `docs/superpowers/specs/2026-10-21-model-checks-dashboard-design.md`

下文 `S\` 指 `src\mcp-servers-for-revit\server\`（仓库内路径 `server/`）。所有工作在分支 `feature/ultraviolet-checks-dashboard` 上进行，不推送。

## Global Constraints

- 只读：检查流程中任何 Revit 调用都必须是只读的（`send_code_to_revit` 一律 `transactionMode: "none"`，脚本不得修改文档）。
- 新工具都不带 `_meta.ui`；工具结果的 `content` 只放摘要（每次 ≤ 4,000 字符），明细放 `structuredContent`。
- 只对主模型构件判定；链接模型只统计数量。
- 每个项目只保留最近 10 次运行的 `check_results`；`failed_ids` 每条规则最多 500 个。
- 条件运算符固定为：`defined notDefined hasValue isEmpty equals notEquals contains matches gt lt`。
- 规则严重度固定为：`error warning info`；导入规则默认 `warning`。
- 不修改 `commandset/`（C# 插件）和 `BACKLOG.md`。

## 规格之外的补充决定（来自实施前验证，2026-10-21）

1. **采集改用只读脚本**：实测 `get_element_data`（`SpecificParameters`）只返回有值的实例参数，拿不到类型参数，也无法区分"不存在"和"为空"。因此 collector 用固定的 `send_code_to_revit` 只读脚本，逐参数返回 `{ defined, hasValue, value, onType }`。已在 Snowdon 模型上验证：门 631418 的 `Fire Rating`（类型参数，"180 MIN"）、`Comments`（存在但为空）、`NoSuchParam`（不存在）都能区分。
2. **参数别名**：IFC-SG XML 里同时出现 `IfcExportAs` 和 `Export to IFC As`，两者视为同一参数（引擎查找时依次尝试）。
3. **查找顺序细化**：先查实例；实例参数不存在，或存在但为空，再查类型；`defined` 表示实例或类型任一处存在。

## Review Focus

1. **规则名、参数名、参数值含引号、反斜杠或中文**：生成的 C# 脚本必须正确转义，不会报编译错误，也不能被注入。由 Task 5 的 `buildCollectScript` 测试覆盖。
2. **模型里完全没有某规则用到的参数（如 IFC-SG 的大部分参数）**：规则应为 `fail`（`defined` 失败）或 `n/a`（`where` 用到的参数不存在，范围为空），不能报错。由 Task 3 测试覆盖。
3. **同名规则集重复导入**：整体替换，不产生重复规则，原来的启停状态不保留（以新文件为准）。由 Task 4 测试覆盖。
4. **检查运行中途 Revit 断开或某类别脚本失败**：运行仍以 `done` 结束，失败类别下的规则为 `n/a` 并附原因；全部类别都失败时运行为 `failed`。由 Task 5 和 Task 6 测试覆盖。
5. **Claude 生成的规则格式错误（缺字段、未知运算符、无效正则）**：`rules_upsert` 逐条返回错误、不写入任何一条。由 Task 1 和 Task 6 测试覆盖。

---

## 第一期：服务端

### Task 1：测试框架与规则格式

**Files：**
- Modify：`S\package.json`（加 `vitest` 开发依赖、`fast-xml-parser` 依赖、`"test": "vitest run"` 脚本）
- Create：`S\vitest.config.ts`（`include: ["test/**/*.test.ts"]`，`environment: "node"`）
- Create：`S\src\checks\ruleFormat.ts`
- Test：`S\test\checks\ruleFormat.test.ts`

**Interfaces：**
- Produces：
  - `type Severity = "error" | "warning" | "info"`
  - `type Op = "defined" | "notDefined" | "hasValue" | "isEmpty" | "equals" | "notEquals" | "contains" | "matches" | "gt" | "lt"`
  - `type Condition = { param: string; op: Op; value?: string; caseInsensitive?: boolean }`
  - `type Rule`：字段同规格 3.1（`id, rulesetId, group, name, description?, severity, enabled, scope{categories, elementKind, where}, require, fix?, source{kind, file?}`）
  - `const RuleSchema: z.ZodType<Rule>`：`categories` 非空且每项以 `OST_` 开头；`require` 非空；`equals notEquals contains matches gt lt` 必须带 `value`；`matches` 的 `value` 必须能被 `new RegExp` 编译；`gt lt` 的 `value` 必须是数字。
  - `validateRules(input: unknown[]): { ok: Rule[]; errors: { index: number; message: string }[] }`：缺 `id` 时生成 `crypto.randomUUID()`。

- [ ] **Step 1：写测试** `ruleFormat.test.ts`：
  - `validateRules([validRule])` → `ok.length === 1`、`errors` 为空。
  - 缺 `require`、`op: "between"`、`{op:"matches", value:"("}`、`{op:"gt", value:"abc"}`、`categories: ["Doors"]` 各自 → `errors[0].index` 正确，`ok` 为空。
  - 缺 `id` 的规则得到 UUID 格式的 `id`。
- [ ] **Step 2：** `npm install`，然后 `npm test` → 因找不到模块而失败。
- [ ] **Step 3：** 实现 `ruleFormat.ts`。
- [ ] **Step 4：** `npm test` → 全部通过；`npx tsc --noEmit` 无错误。
- [ ] **Step 5：** 提交 `feat(checks): rule format and validation`。

### Task 2：Model Checker XML 转换

**Files：**
- Create：`S\src\checks\modelCheckerXml.ts`
- Create：`S\test\checks\fixtures\mini-checkset.xml`（3 条检查：模式 1 一条、模式 2 一条、一条带 `Operator="Or"` 的不支持检查；属性写法照抄 IFC-SG 文件）
- Test：`S\test\checks\modelCheckerXml.test.ts`

**Interfaces：**
- Consumes：Task 1 `Rule`、`RuleSchema`。
- Produces：
  - `type ImportedRule = Rule & { supported: boolean; unsupportedReason?: string }`
  - `parseModelCheckerXml(xml: string, opts: { rulesetId: string; file?: string }): { name: string; rules: ImportedRule[]; groups: string[] }`：`name` 取根元素的 `Name` 属性，没有时用根元素名；`rules` 按文件顺序。

- [ ] **Step 1：写测试**：
  - mini 文件：3 条规则；模式 1 → `scope.where = [{param:"IfcExportAs", op:"equals", value:"IfcDoor"}]`、`elementKind:"instance"`、`require = [{param:"FireRating", op:"defined"}]`；模式 2 → `elementKind:"any"`、`require = [{param:"Export to IFC As", op:"hasValue"}]`；`Or` 那条 `supported:false`、`enabled:false`、带原因。全部 `severity:"warning"`、`group` 等于 Section 名、`id` 等于 XML 的 Check ID。
  - 完整文件（`C:\Users\Datech\Desktop\Cursor Projects\Model Checker Checkset\IFC-SG_ModelValidationChecks_v1.0.xml`，用 `it.skipIf(!existsSync(path))`）：586 条规则，全部 `supported`，`groups.length` 为 92（93 个 Section 中 `<--Unused-->` 没有检查，不计入），`name` 为 `"IFC-SG Schema Model Validation Checks"` 或根元素 `Name` 属性值。
- [ ] **Step 2：** `npm test` → 失败。
- [ ] **Step 3：** 用 `fast-xml-parser`（`ignoreAttributes:false, attributeNamePrefix:""`，`isArray` 让 Section、Check、Filter 始终为数组）实现。Section 可嵌套，要递归遍历。
- [ ] **Step 4：** `npm test` → 通过。如果完整文件的分组数和 92 不符，以实际的非空 Section 数为准，在 Step 5 的提交说明里写明。
- [ ] **Step 5：** 提交 `feat(checks): import Model Checker XML checksets`。

### Task 3：判定引擎

**Files：**
- Create：`S\src\checks\engine.ts`
- Test：`S\test\checks\engine.test.ts`

**Interfaces：**
- Consumes：Task 1 类型。
- Produces：
  - `type ParamValue = { defined: true; hasValue: boolean; value: string | null; onType: boolean } | null`（`null` 表示不存在）
  - `type CollectedElement = { id: number; category: string /* OST_ */; isType: boolean; typeId: number | null; typeName: string; level: string; params: Record<string, ParamValue> }`（`params` 的值分实例和类型：键 `"i:<名>"` 为实例参数，`"t:<名>"` 为类型参数）
  - `const PARAM_ALIASES: Record<string, string[]>`：`{ IfcExportAs: ["Export to IFC As"], "Export to IFC As": ["IfcExportAs"] }`
  - `resolveParam(el: CollectedElement, name: string): { defined: boolean; hasValue: boolean; value: string | null; onType: boolean }`：按补充决定 3 和别名查找。
  - `evalCondition(el: CollectedElement, c: Condition): boolean`
  - `type RuleResult = { ruleId: string; status: "pass" | "fail" | "n/a"; inScope: number; failedCount: number; failedIds: number[] /* ≤500 */; byType: Record<string, number>; fix: string | null; note?: string }`
  - `evaluate(rules: Rule[], elements: CollectedElement[], unavailable?: Record<string /* OST_ */, string /* reason */>): RuleResult[]`
  - `buildFix(rule: Rule, failed: CollectedElement[], reason: "notDefined" | "empty"): string`

- [ ] **Step 1：写测试**（构造 4–6 个元素即可）：
  - 每种 op 的真假各一例；`gt/lt` 遇到非数字为 false；`caseInsensitive`。
  - 实例为空但类型有值 → `hasValue` 为真且 `onType` 为真；只在类型上定义 → `defined` 为真；别名 `IfcExportAs` 能找到 `Export to IFC As`。
  - 范围：类别不匹配、`elementKind` 不匹配、`where` 不成立 → 不计入 `inScope`；`inScope` 为 0 → `n/a`。
  - `unavailable` 里的类别：规则为 `n/a`，`note` 为原因。
  - 失败超过 500 个时 `failedIds.length === 500`、`failedCount` 为真实数量。
  - 建议：参数不存在 → 文本包含 "shared parameter"；失败构件中同一类型占 ≥ 60% → 包含该类型名和数量；其余 → 包含 "01 Elements"；规则带 `fix` 模板时替换 `{param}{count}{category}{type}`。
  - Review Focus 2：模型完全没有 `require` 参数 → `fail`；`where` 参数不存在 → `n/a`，均不抛异常。
- [ ] **Step 2：** `npm test` → 失败。
- [ ] **Step 3：** 实现 `engine.ts`。`byType` 以 `typeName` 为键。
- [ ] **Step 4：** `npm test` → 通过。
- [ ] **Step 5：** 提交 `feat(checks): rule evaluation engine and fix suggestions`。

### Task 4：存储

**Files：**
- Create：`S\src\checks\store.ts`
- Test：`S\test\checks\store.test.ts`

**Interfaces：**
- Consumes：Task 1 `Rule`；Task 2 `ImportedRule`；Task 3 `RuleResult`。
- Produces：`createCheckStore(db: Database.Database)`，执行规格 4.1 的建表语句（`CREATE TABLE IF NOT EXISTS`，并给 `rules.ruleset_id`、`check_runs.project_id`、`check_results.run_id` 建索引），返回：
  - `importRuleset(set: { id: string; name: string; sourceKind: string; sourceFile?: string }, rules: ImportedRule[]): { rules: number; groups: number; unsupported: number }`：同名规则集先删除再写入（事务）。
  - `upsertRules(rules: Rule[]): number`：规则集不存在时自动创建 `{id: rule.rulesetId, name: rule.rulesetId === "mine" ? "My rules" : rule.rulesetId, sourceKind: "claude"}`。
  - `listRulesets(): { id; name; sourceKind; enabled; rules: (Rule & { supported: boolean; unsupportedReason?: string })[] }[]`
  - `setEnabled(target: { ids?: string[]; rulesetId?: string; group?: string }, enabled: boolean): number`
  - `enabledRules(rulesetIds?: string[]): Rule[]`（只返回 `supported` 且启用、且所属规则集启用的规则）
  - `findOrCreateProject(name: string, path: string): number`（使用现有 `projects` 表：按 `project_name` + `project_path` 查找）
  - `startRun(projectId: number): number`；`updateProgress(runId: number, progress: { stage: string; done: number; total: number }): void`（存进 `summary` 的 `progress` 字段）
  - `finishRun(runId: number, results: RuleResult[], summary: RunSummary, status: "done" | "failed", error?: string): void`：写入结果，再清理该项目第 11 次及更早运行的 `check_results`。
  - `getRun(runId?: number, projectId?: number): StoredRun | null`（不传 `runId` 时取该项目最近一次）；`getTrend(projectId: number, limit = 10): { runId: number; at: number; passedPct: number }[]`
  - `type RunSummary = { rules: { pass: number; fail: number; na: number }; bySeverity: Record<Severity, number>; byGroup: Record<string, { rules: number; failing: number }>; categories: Record<string, { host: number; linked: number; compliantPct: number | null }>; parameters: { name: string; where: string[]; fillPct: number }[]; elementsChecked: number; progress?: { stage: string; done: number; total: number } }`
- [ ] **Step 1：写测试**（`new Database(":memory:")`，先手动建一个最小的 `projects` 表）：导入两次同名规则集 → 规则数不翻倍（Review Focus 3）；`setEnabled` 按分组生效；`enabledRules` 排除 unsupported 和已停用规则集；`upsertRules` 自动建 "My rules"；连续 12 次 `finishRun` 后只有最近 10 次有 `check_results`，而 `getTrend` 返回 10 条（最多 10 条）；`failedIds` 写入后读出一致。
- [ ] **Step 2：** `npm test` → 失败。
- [ ] **Step 3：** 实现 `store.ts`。所有写操作放在 `db.transaction` 中。
- [ ] **Step 4：** `npm test` → 通过。
- [ ] **Step 5：** 提交 `feat(checks): SQLite storage for rules and runs`。

### Task 5：数据采集

**Files：**
- Create：`S\src\checks\collector.ts`
- Test：`S\test\checks\collector.test.ts`

**Interfaces：**
- Consumes：Task 1 `Rule`；Task 3 `CollectedElement`、`PARAM_ALIASES`。
- Produces：
  - `type Send = (command: string, params: unknown) => Promise<unknown>`（生产环境为 `(c, p) => withRevitConnection((client) => client.sendCommand(c, p))`）
  - `planCollection(rules: Rule[]): Map<string /* OST_ */, string[] /* 参数名，含别名，去重 */>`
  - `buildCollectScript(category: string, paramNames: string[]): string`：返回 C# 片段，用 `FilteredElementCollector(document).OfCategory((BuiltInCategory)Enum.Parse(typeof(BuiltInCategory), "<OST_>")).WhereElementIsNotElementType()`，对每个元素和每个参数名分别查实例（`LookupParameter`）和类型，输出 `CollectedElement` 结构的 JSON 数组（`params` 键为 `"i:<名>"` / `"t:<名>"`，不存在为 `null`）。字符串字面量用 `JSON.stringify` 生成（C# 兼容的转义）。
  - `readProjectIdentity(send: Send): Promise<{ name: string; path: string }>`（脚本返回 `document.Title` 和 `document.PathName`）
  - `countLinked(send: Send, categories: string[]): Promise<Record<string, number>>`（`query_model`，`includeLinkedModels: true`，统计 `linkInstanceId` 非空的引用数，按类别汇总；失败时返回空对象）
  - `collect(send: Send, plan: Map<string, string[]>, onProgress?: (done: number, total: number) => void): Promise<{ elements: CollectedElement[]; unavailable: Record<string, string> }>`：每个类别一次 `send_code_to_revit`（`transactionMode: "none"`），解析 `result` 字符串；某个类别失败时记入 `unavailable` 并继续。
- [ ] **Step 1：写测试**（模拟 `send`）：
  - `planCollection`：同类别的多条规则合并参数；`IfcExportAs` 自动带上别名 `Export to IFC As`。
  - `buildCollectScript`：参数名含 `"`、`\`、中文 → 生成的字面量用 `JSON.stringify` 转义（断言脚本里出现 `JSON.stringify(name)` 的结果，且不出现未转义的原始引号）（Review Focus 1）；脚本不含 `Transaction`、`Delete(`、`Set(`（只读）。
  - `collect`：两个类别，其中一个的 `send` 抛错 → 结果里另一个类别的元素正常，`unavailable` 记录失败类别；`onProgress` 被调用两次。
- [ ] **Step 2：** `npm test` → 失败。
- [ ] **Step 3：** 实现 `collector.ts`。
- [ ] **Step 4：** `npm test` → 通过。
- [ ] **Step 5：真实模型冒烟测试**：写一个一次性脚本（放在 scratchpad，不提交），用真实的 `withRevitConnection` 对 `OST_Doors` 和参数 `["Fire Rating", "Mark", "Comments", "NoSuchParam"]` 执行 `collect`。
  Expected：门 631418 的 `t:Fire Rating` 为 `{defined:true, hasValue:true, value:"180 MIN", onType:true}`，`i:Comments` 为 `hasValue:false`，`i:NoSuchParam` 和 `t:NoSuchParam` 为 `null`；记录耗时。
- [ ] **Step 6：** 提交 `feat(checks): read-only Revit data collector`。

### Task 6：MCP 工具与运行编排

**Files：**
- Create：`S\src\checks\runner.ts`、`S\src\checks\tools.ts`
- Modify：`S\src\index.ts`（在 `await registerMcpApp(server);` 之后调用 `await registerCheckTools(server);`）
- Test：`S\test\checks\runner.test.ts`、`S\test\checks\tools.test.ts`

**Interfaces：**
- Consumes：Task 1–5 全部导出。
- Produces：
  - `runChecks(deps: { store: CheckStore; send: Send }, opts: { rulesetIds?: string[] }): Promise<{ runId: number; done: Promise<void> }>`：确定项目 → `startRun` → 采集（进度写入 `updateProgress`）→ `evaluate` → 汇总 `RunSummary`（参数填写率 = 范围内构件中该参数 `hasValue` 的比例；类别合规率 = 该类别范围内构件中没有任何失败的比例）→ `finishRun`。全部类别都失败时状态为 `failed`。
  - `registerCheckTools(server: McpServer, deps?: { store?: CheckStore; send?: Send }): Promise<void>`：注册 6 个工具（规格 4.2）。
    - `rules_import_checkset`：`{ path?: string; xml?: string; name?: string }`，`path` 和 `xml` 必须且只能给一个。
    - `rules_upsert`：`{ rules: unknown[] }` → `validateRules`；有任何错误时不写入任何一条，返回全部错误。
    - `rules_list`：`{ rulesetId?: string; group?: string }`；`content` 只给规则集和分组计数，`structuredContent` 给完整列表。
    - `rules_set_enabled`：`{ enabled: boolean; ids?: string[]; rulesetId?: string; group?: string }`，三者至少给一个。
    - `checks_run`：`{ rulesetIds?: string[]; wait?: boolean }`，`wait` 默认 `true`（等待完成并返回摘要），界面传 `false`（立即返回 `runId`）。
    - `checks_get_results`：`{ runId?: number }` → 运行中返回进度；完成后返回 `RunSummary`、按规则结果（附规则名、分组、严重度）、建议列表（按 `failedCount` 降序，最多 50 条）、`getTrend` 的结果。
  - 所有工具的 `content` 文本 ≤ 4,000 字符。
- [ ] **Step 1：写测试**：
  - `runner.test.ts`（内存 SQLite + 模拟 `send`）：一次完整运行写入 `done`、结果和摘要正确；某个类别失败 → 运行为 `done`，相关规则为 `n/a`（Review Focus 4）；全部类别失败 → `failed`。
  - `tools.test.ts`：用 SDK 的 `McpServer` + `InMemoryTransport` 和 `Client` 调用工具：`rules_upsert` 传 1 条好规则和 1 条坏规则 → 两条都不写入、返回坏规则的错误（Review Focus 5）；`rules_import_checkset` 同时给 `path` 和 `xml` → 报错；`checks_get_results` 的 `content[0].text.length ≤ 4000`；所有 6 个工具的 `_meta` 中没有 `ui`。
- [ ] **Step 2：** `npm test` → 失败。
- [ ] **Step 3：** 实现 `runner.ts`、`tools.ts`，修改 `index.ts`。生产环境的 `store` 用 `createCheckStore(getDb())`。
- [ ] **Step 4：** `npm test` 通过；`npm run build` 通过。
- [ ] **Step 5：** 提交 `feat(checks): MCP tools for rules and check runs`。

### Task 7：第一期真实模型验证

**Files：** 无代码改动（发现问题时回到对应任务修复）。

- [ ] **Step 1：** 请用户重启 Claude 加载新服务；确认服务进程启动时间晚于构建时间。
- [ ] **Step 2：** 调用 `rules_import_checkset({ path: IFC-SG 文件 })`。Expected：586 条规则、全部支持。
- [ ] **Step 3：** 调用 `checks_run({})`。Expected：状态 `done`；记录耗时；`content` 中的摘要可读。
- [ ] **Step 4：抽查**（成功标准第 3 条）：从结果中挑 3 个失败构件、3 个通过构件，用 `send_code_to_revit` 的只读脚本核对对应参数，结果必须一致。
- [ ] **Step 5：** 用 `rules_upsert` 建一条自定义规则（"所有门必须填写 Mark"），再运行一次。Expected：规则出现在 `rules_list` 中，有结果。
- [ ] **Step 6：** 向用户报告第一期结果，然后进入第二期。

## 第二期：界面

### Task 8：03 Checks 接入真实数据

**Files：**
- Modify：`S\mcp-app\src\mcp-app.ts`（`renderChecks` 及事件处理）、`S\mcp-app\app.html`（规则详情的样式）
- Create：`S\mcp-app\src\checks-api.ts`
- Modify：模拟宿主 `dev` 测试页（scratchpad 中的 `harness/index.html`，不提交）：加入 6 个工具的内存实现

**Interfaces：**
- Consumes：Task 6 工具的输入输出。
- Produces（`checks-api.ts`）：`listRules(): Promise<RulesetView[]>`、`setEnabled(target, enabled): Promise<void>`、`importXml(xml: string, name?: string): Promise<ImportSummary>`、`upsertRule(rule: Rule): Promise<void>`、`runChecks(): Promise<number>`、`getResults(runId?: number): Promise<ResultsView>`（都基于 `app.callServerTool`；工具返回 `isError` 时抛出带服务端消息的 `Error`）。

- [ ] **Step 1：** 03 改为调用 `listRules()` 渲染；开关调用 `setEnabled` 后重新读取；分组可展开到单条规则，可在原位修改严重度、名称和建议文字（`upsertRule`）；不支持的规则单独列出并显示原因。
- [ ] **Step 2：** **import xml**：隐藏的 `<input type="file" accept=".xml">`，用 `FileReader` 读取文本后调用 `importXml`，完成后显示"Imported N rules (M unsupported)"。
- [ ] **Step 3：** **ask claude ↗**：`app.getHostCapabilities()?.message` 存在时，调用 `app.sendMessage({ role: "user", content: [{ type: "text", text: "Create a rule: <描述>" }] })`；否则用 `navigator.clipboard.writeText`，并提示"Copied — paste it to Claude"。
- [ ] **Step 4：** 删除 `checks-mock.ts` 中的规则集部分；类型检查和构建都通过。
- [ ] **Step 5：** 在模拟宿主中，明暗两种主题下验证：列表、开关、导入（用 mini 测试 XML）、发消息和复制两条路径、错误提示。截图记录。
- [ ] **Step 6：** 提交 `feat(app): wire 03 Checks to rule tools`。

### Task 9：04 Dashboard 与运行检查

**Files：**
- Modify：`S\mcp-app\src\mcp-app.ts`（`renderDashboard`、Run checks、模型上下文）
- Delete：`S\mcp-app\src\checks-mock.ts`

- [ ] **Step 1：** **Run checks →** 调用 `runChecks()`，之后每秒调用 `getResults(runId)`，在 Dock 显示 `stage done/total`，运行期间禁用按钮；完成后刷新 03 和 04。
- [ ] **Step 2：** 04 用 `getResults()` 渲染：通过率与上次对比、趋势（`getTrend`）、问题计数、类别合规率（主模型）与链接数量、参数填写率、建议列表（最多 20 条）；注明"逐构件判定，比 Model Checker 更严格"；没有运行记录时显示空状态，引导到 03。去掉所有"sample"标记和示例说明。
- [ ] **Step 3：** 模型上下文追加：当前标签页、最近一次运行的摘要（通过率、错误数、警告数）、前 5 条建议标题。
- [ ] **Step 4：** 类型检查、构建；在模拟宿主中验证运行进度、完成后的刷新、空状态、明暗主题。截图记录。
- [ ] **Step 5：** 请用户重启 Claude，在真实模型上从 03 运行一次，并对照 Task 7 的结果检查 04。
- [ ] **Step 6：** 提交 `feat(app): live 04 Dashboard and run checks`。

### Task 10：整体审查

- [ ] **Step 1：** 由一个新的审查代理（最强模型）对整个分支做审查，并带上本计划的 Review Focus。
- [ ] **Step 2：** 修复 Critical 和 Important 级问题，每个修复先写一个会失败的测试，再修到通过；Minor 级问题记录下来交给用户决定。
- [ ] **Step 3：** 向用户汇报：分支上的全部提交、自己做出的决定和代价、暂缓的问题。合并或推送由用户决定。
