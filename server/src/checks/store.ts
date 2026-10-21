import type Database from "better-sqlite3";
import type { RuleResult } from "./engine.js";
import type { ImportedRule } from "./modelCheckerXml.js";
import type { Rule, Severity } from "./ruleFormat.js";

const KEEP_DETAILED_RUNS = 10;

export type RunProgress = { stage: string; done: number; total: number };

export type RunSummary = {
  rules: { pass: number; fail: number; na: number };
  bySeverity: Record<Severity, number>;
  byGroup: Record<string, { rules: number; failing: number }>;
  categories: Record<string, { host: number; linked: number; compliantPct: number | null }>;
  parameters: { name: string; where: string[]; fillPct: number }[];
  elementsChecked: number;
  progress?: RunProgress;
};

export type StoredRule = Rule & { supported: boolean; unsupportedReason?: string };

export type StoredRun = {
  id: number;
  projectId: number;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "done" | "failed";
  error: string | null;
  summary: RunSummary | null;
  results: RuleResult[];
};

export type CheckStore = ReturnType<typeof createCheckStore>;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rulesets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_file TEXT,
    imported_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS rules (
    id TEXT NOT NULL,
    ruleset_id TEXT NOT NULL REFERENCES rulesets(id) ON DELETE CASCADE,
    grp TEXT NOT NULL,
    name TEXT NOT NULL,
    severity TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    supported INTEGER NOT NULL,
    unsupported_reason TEXT,
    body TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ruleset_id, id)
  );
  CREATE TABLE IF NOT EXISTS check_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    status TEXT NOT NULL,
    error TEXT,
    elements_checked INTEGER,
    rules_run INTEGER,
    passed INTEGER,
    failed INTEGER,
    summary TEXT
  );
  CREATE TABLE IF NOT EXISTS check_results (
    run_id INTEGER NOT NULL REFERENCES check_runs(id) ON DELETE CASCADE,
    rule_id TEXT NOT NULL,
    status TEXT NOT NULL,
    in_scope INTEGER NOT NULL,
    failed_count INTEGER NOT NULL,
    failed_ids TEXT NOT NULL,
    by_type TEXT NOT NULL,
    fix TEXT,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rules_ruleset ON rules(ruleset_id);
  CREATE INDEX IF NOT EXISTS idx_check_runs_project ON check_runs(project_id);
  CREATE INDEX IF NOT EXISTS idx_check_results_run ON check_results(run_id);
`;

type RuleRow = {
  ruleset_id: string;
  enabled: number;
  supported: number;
  unsupported_reason: string | null;
  body: string;
  grp: string;
  name: string;
  severity: string;
};

function rowToRule(row: RuleRow): StoredRule {
  const body = JSON.parse(row.body) as Rule;
  return {
    ...body,
    rulesetId: row.ruleset_id,
    group: row.grp,
    name: row.name,
    severity: row.severity as Severity,
    enabled: row.enabled === 1,
    supported: row.supported === 1,
    ...(row.unsupported_reason ? { unsupportedReason: row.unsupported_reason } : {}),
  };
}

export function createCheckStore(db: Database.Database) {
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  const insertRule = db.prepare(
    `INSERT INTO rules (id, ruleset_id, grp, name, severity, enabled, supported, unsupported_reason, body, updated_at)
     VALUES (@id, @rulesetId, @grp, @name, @severity, @enabled, @supported, @reason, @body, @now)
     ON CONFLICT(ruleset_id, id) DO UPDATE SET grp = excluded.grp, name = excluded.name, severity = excluded.severity,
       enabled = excluded.enabled, supported = excluded.supported, unsupported_reason = excluded.unsupported_reason,
       body = excluded.body, updated_at = excluded.updated_at`
  );

  function writeRule(rule: Rule, supported = true, reason?: string) {
    const { supported: _s, unsupportedReason: _r, ...body } = rule as StoredRule;
    insertRule.run({
      id: rule.id,
      rulesetId: rule.rulesetId,
      grp: rule.group,
      name: rule.name,
      severity: rule.severity,
      enabled: rule.enabled ? 1 : 0,
      supported: supported ? 1 : 0,
      reason: reason ?? null,
      body: JSON.stringify(body),
      now: Date.now(),
    });
  }

  const importRuleset = db.transaction(
    (set: { id: string; name: string; sourceKind: string; sourceFile?: string }, rules: ImportedRule[]) => {
      db.prepare("DELETE FROM rulesets WHERE id = ? OR name = ?").run(set.id, set.name);
      db.prepare(
        "INSERT INTO rulesets (id, name, source_kind, source_file, imported_at, enabled) VALUES (?, ?, ?, ?, ?, 1)"
      ).run(set.id, set.name, set.sourceKind, set.sourceFile ?? null, Date.now());
      for (const rule of rules) writeRule({ ...rule, rulesetId: set.id }, rule.supported, rule.unsupportedReason);
      return {
        rules: rules.length,
        groups: new Set(rules.map((r) => r.group)).size,
        unsupported: rules.filter((r) => !r.supported).length,
      };
    }
  );

  const upsertRules = db.transaction((rules: Rule[]) => {
    for (const rule of rules) {
      const exists = db.prepare("SELECT 1 FROM rulesets WHERE id = ?").get(rule.rulesetId);
      if (!exists) {
        db.prepare(
          "INSERT INTO rulesets (id, name, source_kind, source_file, imported_at, enabled) VALUES (?, ?, 'claude', NULL, ?, 1)"
        ).run(rule.rulesetId, rule.rulesetId === "mine" ? "My rules" : rule.rulesetId, Date.now());
      }
      writeRule(rule);
    }
    return rules.length;
  });

  function listRulesets() {
    const sets = db.prepare("SELECT * FROM rulesets ORDER BY imported_at").all() as {
      id: string;
      name: string;
      source_kind: string;
      enabled: number;
    }[];
    const rules = (db.prepare("SELECT * FROM rules ORDER BY rowid").all() as RuleRow[]).map(rowToRule);
    return sets.map((s) => ({
      id: s.id,
      name: s.name,
      sourceKind: s.source_kind,
      enabled: s.enabled === 1,
      rules: rules.filter((r) => r.rulesetId === s.id),
    }));
  }

  function setEnabled(target: { ids?: string[]; rulesetId?: string; group?: string }, enabled: boolean): number {
    const flag = enabled ? 1 : 0;
    if (target.ids?.length) {
      const stmt = db.prepare("UPDATE rules SET enabled = ? WHERE id = ?");
      return db.transaction(() => target.ids!.reduce((n, id) => n + stmt.run(flag, id).changes, 0))();
    }
    if (target.group) {
      const sql = target.rulesetId
        ? "UPDATE rules SET enabled = ? WHERE grp = ? AND ruleset_id = ?"
        : "UPDATE rules SET enabled = ? WHERE grp = ?";
      const args = target.rulesetId ? [flag, target.group, target.rulesetId] : [flag, target.group];
      return db.prepare(sql).run(...args).changes;
    }
    if (target.rulesetId) {
      db.prepare("UPDATE rulesets SET enabled = ? WHERE id = ?").run(flag, target.rulesetId);
      return (db.prepare("SELECT COUNT(*) AS n FROM rules WHERE ruleset_id = ?").get(target.rulesetId) as { n: number }).n;
    }
    return 0;
  }

  function enabledRules(rulesetIds?: string[]): Rule[] {
    const rows = db
      .prepare(
        `SELECT rules.* FROM rules JOIN rulesets ON rulesets.id = rules.ruleset_id
         WHERE rules.enabled = 1 AND rules.supported = 1 AND rulesets.enabled = 1 ORDER BY rules.rowid`
      )
      .all() as RuleRow[];
    return rows
      .filter((r) => !rulesetIds?.length || rulesetIds.includes(r.ruleset_id))
      .map((r) => {
        const { supported: _s, unsupportedReason: _u, ...rule } = rowToRule(r);
        return rule;
      });
  }

  function findOrCreateProject(name: string, path: string): number {
    const row = db
      .prepare("SELECT id FROM projects WHERE project_name = ? AND IFNULL(project_path, '') = ?")
      .get(name, path) as { id: number } | undefined;
    if (row) return row.id;
    const now = Date.now();
    return Number(
      db
        .prepare("INSERT INTO projects (project_name, project_path, timestamp, last_updated) VALUES (?, ?, ?, ?)")
        .run(name, path, now, now).lastInsertRowid
    );
  }

  function startRun(projectId: number): number {
    return Number(
      db
        .prepare("INSERT INTO check_runs (project_id, started_at, status) VALUES (?, ?, 'running')")
        .run(projectId, Date.now()).lastInsertRowid
    );
  }

  function updateProgress(runId: number, progress: RunProgress) {
    const row = db.prepare("SELECT summary FROM check_runs WHERE id = ?").get(runId) as { summary: string | null } | undefined;
    const summary = row?.summary ? JSON.parse(row.summary) : {};
    db.prepare("UPDATE check_runs SET summary = ? WHERE id = ?").run(JSON.stringify({ ...summary, progress }), runId);
  }

  const finishRun = db.transaction(
    (runId: number, results: RuleResult[], summary: RunSummary, status: "done" | "failed", error?: string) => {
      const insert = db.prepare(
        `INSERT INTO check_results (run_id, rule_id, status, in_scope, failed_count, failed_ids, by_type, fix, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of results) {
        insert.run(runId, r.ruleId, r.status, r.inScope, r.failedCount, JSON.stringify(r.failedIds), JSON.stringify(r.byType), r.fix, r.note ?? null);
      }
      db.prepare(
        `UPDATE check_runs SET finished_at = ?, status = ?, error = ?, elements_checked = ?, rules_run = ?, passed = ?,
           failed = ?, summary = ? WHERE id = ?`
      ).run(Date.now(), status, error ?? null, summary.elementsChecked, results.length, summary.rules.pass, summary.rules.fail, JSON.stringify({ ...summary, progress: undefined }), runId);
      const project = db.prepare("SELECT project_id FROM check_runs WHERE id = ?").get(runId) as { project_id: number };
      db.prepare(
        `DELETE FROM check_results WHERE run_id IN (
           SELECT id FROM check_runs WHERE project_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?)`
      ).run(project.project_id, KEEP_DETAILED_RUNS);
    }
  );

  function getRun(runId?: number, projectId?: number): StoredRun | null {
    const row = (
      runId != null
        ? db.prepare("SELECT * FROM check_runs WHERE id = ?").get(runId)
        : projectId != null
          ? db.prepare("SELECT * FROM check_runs WHERE project_id = ? ORDER BY id DESC LIMIT 1").get(projectId)
          : db.prepare("SELECT * FROM check_runs ORDER BY id DESC LIMIT 1").get()
    ) as
      | { id: number; project_id: number; started_at: number; finished_at: number | null; status: StoredRun["status"]; error: string | null; summary: string | null }
      | undefined;
    if (!row) return null;
    const results = (
      db.prepare("SELECT * FROM check_results WHERE run_id = ? ORDER BY rowid").all(row.id) as {
        rule_id: string;
        status: RuleResult["status"];
        in_scope: number;
        failed_count: number;
        failed_ids: string;
        by_type: string;
        fix: string | null;
        note: string | null;
      }[]
    ).map((r) => ({
      ruleId: r.rule_id,
      status: r.status,
      inScope: r.in_scope,
      failedCount: r.failed_count,
      failedIds: JSON.parse(r.failed_ids) as number[],
      byType: JSON.parse(r.by_type) as Record<string, number>,
      fix: r.fix,
      ...(r.note ? { note: r.note } : {}),
    }));
    return {
      id: row.id,
      projectId: row.project_id,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status,
      error: row.error,
      summary: row.summary ? (JSON.parse(row.summary) as RunSummary) : null,
      results,
    };
  }

  function getTrend(projectId: number, limit = KEEP_DETAILED_RUNS) {
    const rows = db
      .prepare(
        `SELECT id, finished_at, passed, failed FROM check_runs WHERE project_id = ? AND status = 'done'
         ORDER BY id DESC LIMIT ?`
      )
      .all(projectId, limit) as { id: number; finished_at: number; passed: number; failed: number }[];
    return rows.reverse().map((r) => ({
      runId: r.id,
      at: r.finished_at,
      passedPct: r.passed + r.failed ? Math.round((r.passed / (r.passed + r.failed)) * 100) : 100,
    }));
  }

  return {
    importRuleset,
    upsertRules,
    listRulesets,
    setEnabled,
    enabledRules,
    findOrCreateProject,
    startRun,
    updateProgress,
    finishRun,
    getRun,
    getTrend,
  };
}
