import type { App } from "@modelcontextprotocol/ext-apps";

export type Severity = "error" | "warning" | "info";

export type RuleView = {
  id: string;
  rulesetId: string;
  group: string;
  name: string;
  severity: Severity;
  enabled: boolean;
  supported: boolean;
  unsupportedReason?: string;
  [key: string]: unknown;
};

export type RulesetView = { id: string; name: string; sourceKind: string; enabled: boolean; rules: RuleView[] };

export type RuleResultView = {
  ruleId: string;
  status: "pass" | "fail" | "n/a";
  inScope: number;
  failedCount: number;
  failedIds: number[];
  byType: Record<string, number>;
  fix: string | null;
  note?: string;
  name: string;
  group: string;
  severity: Severity;
  rulesetId: string;
};

export type RunSummaryView = {
  rules: { pass: number; fail: number; na: number };
  bySeverity: Record<Severity, number>;
  byGroup: Record<string, { rules: number; failing: number }>;
  categories: Record<string, { host: number; linked: number; compliantPct: number | null }>;
  parameters: { name: string; where: string[]; fillPct: number }[];
  elementsChecked: number;
  progress?: { stage: string; done: number; total: number };
};

export type ResultsView = {
  run: {
    id: number;
    status: "running" | "done" | "failed";
    startedAt: number;
    finishedAt: number | null;
    error: string | null;
    progress: { stage: string; done: number; total: number } | null;
  } | null;
  summary?: RunSummaryView | null;
  results?: RuleResultView[];
  fixes?: { ruleId: string; name: string; group: string; severity: Severity; failedCount: number; fix: string | null; byType: Record<string, number> }[];
  trend?: { runId: number; at: number; passedPct: number }[];
};

type ToolResult = { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };

/** Thin wrapper over the rules_* / checks_* server tools. Tool errors become Errors with the server's message. */
export function createChecksApi(app: App) {
  async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const result = (await app.callServerTool({ name, arguments: args })) as ToolResult;
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    if (result.isError) throw new Error(text || `${name} failed`);
    return (result.structuredContent ?? {}) as T;
  }
  return {
    // The app asks for full detail; the tools default to small summaries for the model.
    listRules: async () => (await call<{ rulesets: RulesetView[] }>("rules_list", { detail: "full" })).rulesets ?? [],
    setEnabled: (target: { ids?: string[]; rulesetId?: string; group?: string }, enabled: boolean) =>
      call<{ changed: number }>("rules_set_enabled", { ...target, enabled }),
    importXml: (xml: string, name?: string) =>
      call<{ name: string; rules: number; groups: number; unsupported: number; disabled: number }>("rules_import_checkset", name ? { xml, name } : { xml }),
    upsertRule: (rule: RuleView) => {
      const { supported: _s, unsupportedReason: _u, ...body } = rule;
      return call<{ saved: number }>("rules_upsert", { rules: [body] });
    },
    runChecks: async () => (await call<{ runId: number }>("checks_run", { wait: false })).runId,
    getResults: (runId?: number) =>
      call<ResultsView>("checks_get_results", runId != null ? { runId, detail: "full" } : { detail: "full" }),
  };
}

export type ChecksApi = ReturnType<typeof createChecksApi>;
