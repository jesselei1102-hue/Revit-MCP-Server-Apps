import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { getDb } from "../database/db.js";
import { withRevitConnection } from "../utils/ConnectionManager.js";
import { readProjectIdentity, type Send } from "./collector.js";
import { parseModelCheckerXml } from "./modelCheckerXml.js";
import { validateRules } from "./ruleFormat.js";
import { runChecks } from "./runner.js";
import { createCheckStore, type CheckStore, type StoredRun } from "./store.js";

const MAX_CONTENT = 4000;
const MAX_FIXES = 50;

const clip = (text: string) => (text.length > MAX_CONTENT ? `${text.slice(0, MAX_CONTENT - 1)}…` : text);
const text = (t: string) => [{ type: "text" as const, text: clip(t) }];
const fail = (message: string) => ({ content: text(message), isError: true });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ruleset";
const time = (ms: number | null) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "—");

const defaultSend: Send = (command, params) =>
  withRevitConnection((client) => client.sendCommand(command, params as Record<string, unknown>));

/** Everything the dashboard needs for one run, plus a short summary for the model. */
function resultsPayload(store: CheckStore, run: StoredRun) {
  const meta = new Map(
    store.listRulesets().flatMap((s) => s.rules.map((r) => [r.id, { name: r.name, group: r.group, severity: r.severity, rulesetId: s.id }] as const))
  );
  const results = run.results.map((r) => ({ ...r, ...(meta.get(r.ruleId) ?? { name: r.ruleId, group: "", severity: "warning", rulesetId: "" }) }));
  const fixes = results
    .filter((r) => r.status === "fail")
    .sort((a, b) => b.failedCount - a.failedCount)
    .slice(0, MAX_FIXES)
    .map((r) => ({ ruleId: r.ruleId, name: r.name, group: r.group, severity: r.severity, failedCount: r.failedCount, fix: r.fix, byType: r.byType }));
  const trend = store.getTrend(run.projectId);
  const s = run.summary;
  let summary: string;
  if (run.status === "running") {
    const p = s?.progress;
    summary = `Run #${run.id} is running${p ? ` — ${p.stage} ${p.done}/${p.total}` : ""}.`;
  } else if (run.status === "failed") {
    summary = `Run #${run.id} failed: ${run.error ?? "unknown error"}`;
  } else {
    const rated = (s?.rules.pass ?? 0) + (s?.rules.fail ?? 0);
    const pct = rated ? Math.round(((s?.rules.pass ?? 0) / rated) * 100) : 100;
    summary = [
      `Run #${run.id} done at ${time(run.finishedAt)} — ${s?.rules.pass} pass · ${s?.rules.fail} fail · ${s?.rules.na} n/a rules (${pct}% passing).`,
      `Issues: ${s?.bySeverity.error} errors · ${s?.bySeverity.warning} warnings · ${s?.bySeverity.info} info across ${s?.elementsChecked} elements.`,
      fixes.length ? "Top fixes:" : "No failing rules.",
      ...fixes.slice(0, 8).map((f, i) => `${i + 1}. [${f.severity}] ${f.name} — ${f.failedCount} failing: ${f.fix ?? ""}`),
      "Details are in the 04 Dashboard tab of the Schedule app.",
    ].join("\n");
  }
  return {
    content: text(summary),
    structuredContent: {
      run: { id: run.id, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error, progress: s?.progress ?? null },
      summary: s,
      results,
      fixes,
      trend,
    },
  };
}

export async function registerCheckTools(server: McpServer, deps: { store?: CheckStore; send?: Send } = {}): Promise<void> {
  let storeInstance = deps.store;
  const store = () => (storeInstance ??= createCheckStore(getDb()));
  const send = deps.send ?? defaultSend;
  let activeRun: number | null = null;

  server.registerTool(
    "rules_import_checkset",
    {
      title: "Import a Model Checker checkset",
      description:
        "Import an Autodesk Model Checker checkset (.xml, e.g. IFC-SG) as a rule set for checks_run. Give exactly one of `path` (file on this computer) or `xml` (file contents). Re-importing a set with the same name replaces it.",
      inputSchema: {
        path: z.string().optional().describe("Absolute path to the .xml checkset."),
        xml: z.string().optional().describe("The checkset XML text (used by the app's import button)."),
        name: z.string().optional().describe("Rule set name; defaults to the checkset's own name."),
      },
    },
    async ({ path: filePath, xml, name }) => {
      if ((filePath == null) === (xml == null)) return fail("Give exactly one of path or xml.");
      let source = xml ?? "";
      if (filePath) {
        try {
          source = await fs.readFile(filePath, "utf8");
        } catch (error) {
          return fail(`Couldn't read ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        const probe = parseModelCheckerXml(source, { rulesetId: "probe" });
        const setName = name?.trim() || probe.name;
        const id = slug(setName);
        const file = filePath ? path.basename(filePath) : "uploaded.xml";
        const parsed = parseModelCheckerXml(source, { rulesetId: id, file });
        const counts = store().importRuleset({ id, name: setName, sourceKind: "model-checker-xml", sourceFile: file }, parsed.rules);
        const disabled = parsed.rules.filter((r) => r.supported && !r.enabled).length;
        return {
          content: text(
            `Imported "${setName}": ${counts.rules} rules in ${counts.groups} groups (${counts.unsupported} unsupported, ${disabled} disabled — e.g. copies for another Revit version). Run checks_run to check the model.`
          ),
          structuredContent: { rulesetId: id, name: setName, ...counts, disabled },
        };
      } catch (error) {
        return fail(`Couldn't import the checkset: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.registerTool(
    "rules_upsert",
    {
      title: "Create or update check rules",
      description:
        "Create or update rules for checks_run (use this to turn a user's plain-language rule into a rule). Each rule: { name, group, severity: error|warning|info, scope: { categories: [OST_…], elementKind: instance|type|any, where?: Condition[] }, require: Condition[], fix?, id?, rulesetId? (default \"mine\" = My rules), enabled? }. Condition: { param, op: defined|notDefined|hasValue|isEmpty|equals|notEquals|contains|matches|gt|lt, value?, caseInsensitive? }. Parameters are looked up on the instance, then its type. If any rule is invalid, nothing is saved.",
      inputSchema: { rules: z.array(z.record(z.unknown())).min(1).describe("Rules to save.") },
    },
    async ({ rules }) => {
      const prepared = rules.map((r) => ({ rulesetId: "mine", source: { kind: "claude" }, ...r }));
      const { ok, errors } = validateRules(prepared);
      if (errors.length) return fail(`Nothing saved. ${errors.map((e) => `rules[${e.index}]: ${e.message}`).join(" | ")}`);
      const saved = store().upsertRules(ok);
      return {
        content: text(`Saved ${saved} rule(s): ${ok.map((r) => `"${r.name}"`).join(", ")}.`),
        structuredContent: { saved, ids: ok.map((r) => r.id) },
      };
    }
  );

  server.registerTool(
    "rules_list",
    {
      title: "List check rules",
      description: "List rule sets, their groups and rules (enabled state, support status).",
      inputSchema: {
        rulesetId: z.string().optional(),
        group: z.string().optional(),
      },
    },
    async ({ rulesetId, group }) => {
      const sets = store()
        .listRulesets()
        .filter((s) => !rulesetId || s.id === rulesetId)
        .map((s) => ({ ...s, rules: s.rules.filter((r) => !group || r.group === group) }));
      const lines = sets.map((s) => {
        const groups = new Set(s.rules.map((r) => r.group)).size;
        const on = s.rules.filter((r) => r.enabled && r.supported).length;
        const unsupported = s.rules.filter((r) => !r.supported).length;
        return `- ${s.name} (${s.id})${s.enabled ? "" : " [off]"}: ${s.rules.length} rules in ${groups} groups, ${on} enabled, ${unsupported} unsupported`;
      });
      return {
        content: text(sets.length ? lines.join("\n") : "No rule sets yet. Import a checkset or create rules."),
        structuredContent: { rulesets: sets },
      };
    }
  );

  server.registerTool(
    "rules_set_enabled",
    {
      title: "Enable or disable check rules",
      description: "Turn rules on or off by rule ids, by group, or a whole rule set.",
      inputSchema: {
        enabled: z.boolean(),
        ids: z.array(z.string()).optional(),
        rulesetId: z.string().optional(),
        group: z.string().optional(),
      },
    },
    async ({ enabled, ids, rulesetId, group }) => {
      if (!ids?.length && !rulesetId && !group) return fail("Give ids, group or rulesetId.");
      const changed = store().setEnabled({ ids, rulesetId, group }, enabled);
      return { content: text(`${enabled ? "Enabled" : "Disabled"} ${changed} rule(s).`), structuredContent: { changed } };
    }
  );

  server.registerTool(
    "checks_run",
    {
      title: "Run model checks",
      description:
        "Check the open Revit model against all enabled rules (read-only). By default waits and returns a summary; the Schedule app passes wait:false and polls checks_get_results.",
      inputSchema: {
        rulesetIds: z.array(z.string()).optional(),
        wait: z.boolean().optional().describe("Wait for completion (default true)."),
      },
    },
    async ({ rulesetIds, wait }) => {
      if (activeRun != null) return fail(`A check run is already in progress (run #${activeRun}).`);
      if (store().enabledRules(rulesetIds).length === 0) return fail("No enabled rules. Import a checkset or create rules first.");
      let started: { runId: number; done: Promise<void> };
      try {
        started = await runChecks({ store: store(), send }, { rulesetIds });
      } catch (error) {
        return fail(`Couldn't start the check: ${error instanceof Error ? error.message : String(error)}`);
      }
      activeRun = started.runId;
      const finished = started.done.finally(() => {
        activeRun = null;
      });
      if (wait === false) {
        return { content: text(`Started check run #${started.runId}.`), structuredContent: { runId: started.runId, status: "running" } };
      }
      await finished;
      return resultsPayload(store(), store().getRun(started.runId)!);
    }
  );

  server.registerTool(
    "checks_get_results",
    {
      title: "Get model check results",
      description: "Latest check run for the open model (or a given runId): progress while running, then summary, per-rule results, ranked fixes and the trend of recent runs.",
      inputSchema: { runId: z.number().int().optional() },
    },
    async ({ runId }) => {
      let run: StoredRun | null = null;
      if (runId != null) run = store().getRun(runId);
      else {
        try {
          const identity = await readProjectIdentity(send);
          run = store().getRun(undefined, store().findOrCreateProject(identity.name, identity.path));
        } catch {
          run = store().getRun();
        }
      }
      if (!run) return { content: text("No check runs yet for this model. Run checks_run."), structuredContent: { run: null } };
      return resultsPayload(store(), run);
    }
  );
}
