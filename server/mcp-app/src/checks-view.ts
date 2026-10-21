// 03 Checks (rule sets, toggles, import, ask Claude) and 04 Dashboard (read-only results) on the
// rules_* / checks_* server tools. mcp-app.ts owns the tabs and the dock; this module owns the two panels.
import type { App } from "@modelcontextprotocol/ext-apps";
import { createChecksApi, type ResultsView, type RuleView, type RulesetView, type Severity } from "./checks-api";

type Deps = {
  app: App;
  checksView: HTMLElement;
  dashboardView: HTMLElement;
  setStatus: (message: string) => void;
  escapeHtml: (value: string) => string;
  pad3: (value: number | undefined) => string;
  /** Glyph svg for a display category name ("Doors"). */
  categoryGlyph: (name: string) => string;
  /** OST_Doors → "Doors". */
  categoryName: (ost: string) => string;
  /** Called whenever dock text, counts or model context may have changed. */
  onChange: () => void;
};

const POLL_MS = 1000;
const MAX_FIXES = 20;

export function createChecksView(deps: Deps) {
  const { escapeHtml: esc, pad3 } = deps;
  const api = createChecksApi(deps.app);
  let rulesets: RulesetView[] = [];
  let latest: ResultsView | null = null;
  let loaded = false;
  let loading: Promise<void> | null = null;
  let runningId: number | null = null;
  let activePanel: "checks" | "dashboard" | null = null;
  const expanded = new Set<string>();

  /** Node keys live in HTML attributes: keep them printable (the parser rewrites NUL). */
  const nodeKey = (setId: string, kind: string, name: string) => `${encodeURIComponent(setId)}:${kind}:${encodeURIComponent(name)}`;
  const resultByRule = () => new Map((latest?.results ?? []).map((r) => [r.ruleId, r]));
  const time = (ms: number | null | undefined) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "—");
  const runnable = (r: RuleView, set: RulesetView) => r.supported && r.enabled && set.enabled;

  function enabledCount() {
    return rulesets.reduce((n, s) => n + s.rules.filter((r) => runnable(r, s)).length, 0);
  }

  async function refresh() {
    loading ??= (async () => {
      try {
        const [sets, results] = await Promise.all([api.listRules(), api.getResults()]);
        rulesets = sets;
        if (runningId == null) latest = results;
        loaded = true;
      } catch (error) {
        deps.setStatus(`Couldn't load checks: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        loading = null;
      }
    })();
    await loading;
    renderActive();
    deps.onChange();
  }

  function renderActive() {
    if (activePanel === "checks") renderChecks();
    if (activePanel === "dashboard") renderDashboard();
  }

  async function show(panel: "checks" | "dashboard") {
    activePanel = panel;
    renderActive();
    if (!loaded) await refresh();
  }

  // ------------------------------------------------------------------ 03 Checks

  const toggle = (attrs: string, rules: RuleView[], label: string) => {
    const on = rules.filter((r) => r.enabled).length;
    const state = on === 0 ? "false" : on === rules.length ? "true" : "mixed";
    return `<button type="button" class="tog" role="switch" aria-checked="${state}" aria-label="${esc(label)}" ${attrs}></button>`;
  };
  const dot = (severity: Severity) => `<i class="sev ${severity}" aria-hidden="true"></i>`;

  function nodeStatus(rules: RuleView[], set: RulesetView) {
    const results = resultByRule();
    const live = rules.filter((r) => runnable(r, set));
    if (live.length === 0) return `<span class="dim">off</span>`;
    const res = live.map((r) => results.get(r.id)).filter(Boolean);
    if (res.length === 0) return `<span class="dim">not run</span>`;
    const failing = res.filter((r) => r!.status === "fail").length;
    if (failing) return `<span class="fail-tx">${failing} failing</span>`;
    return res.every((r) => r!.status === "n/a") ? `<span class="dim">n/a</span>` : `<span class="dim">all pass</span>`;
  }

  function ruleLine(rule: RuleView, set: RulesetView) {
    const r = resultByRule().get(rule.id);
    const state = !runnable(rule, set) ? "off" : !r ? "not run" : r.status === "fail" ? `${r.failedCount} failing` : r.status;
    const sev = (["error", "warning", "info"] as const)
      .map((s) => `<option value="${s}"${s === rule.severity ? " selected" : ""}>${s}</option>`)
      .join("");
    return `<div class="line rule-line"><span>${dot(rule.severity)}${esc(rule.name)} <span class="${
      state.endsWith("failing") ? "fail-tx" : "dim"
    }">· ${esc(state)}</span></span><span class="rule-ctl"><select class="sev-select" data-act="sev" data-set="${esc(set.id)}" data-rule="${esc(
      rule.id
    )}" aria-label="Severity">${sev}</select>${toggle(`data-act="rule" data-set="${esc(set.id)}" data-rule="${esc(rule.id)}"`, [rule], rule.name)}</span></div>`;
  }

  function groupLines(set: RulesetView, rules: RuleView[], prefix: string) {
    const groups = new Map<string, RuleView[]>();
    for (const r of rules) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
    let html = "";
    for (const [group, list] of groups) {
      const key = nodeKey(set.id, "g", group);
      const open = expanded.has(key);
      const label = prefix && group.startsWith(`${prefix} / `) ? group.slice(prefix.length + 3) : group;
      html += `<div class="line${prefix ? " indent" : ""}"><span><button type="button" class="exp" data-act="expand" data-key="${esc(key)}" aria-expanded="${open}">${
        open ? "▾" : "▸"
      } ${esc(label)}</button> <span class="dim">· ${list.length} rules</span> ${nodeStatus(list, set)}</span>${toggle(
        `data-act="group" data-set="${esc(set.id)}" data-group="${esc(group)}"`,
        list,
        `${label} enabled`
      )}</div>`;
      if (open) html += `<div class="rules">${list.map((r) => ruleLine(r, set)).join("")}</div>`;
    }
    return html;
  }

  function setCard(set: RulesetView) {
    const supported = set.rules.filter((r) => r.supported);
    const unsupported = set.rules.filter((r) => !r.supported);
    const on = supported.filter((r) => r.enabled).length;
    const source = set.sourceKind === "model-checker-xml" ? "xml" : "created with Claude";
    let html = `<div class="card"><div class="card-head"><span><b>${esc(set.name)}</b> <span class="dim">· ${set.rules.length} rules · ${on} on · ${source}</span></span><button type="button" class="tog" role="switch" aria-checked="${set.enabled}" aria-label="${esc(
      set.name
    )} enabled" data-act="set" data-set="${esc(set.id)}"></button></div><div class="rows">`;
    // Checksets with headings (e.g. "Revit 2023 and 2024 / Architecture (ARC) / Doors") get a heading level.
    const heads = new Map<string, RuleView[]>();
    for (const r of supported) {
      const head = r.group.includes(" / ") ? r.group.split(" / ")[0] : "";
      heads.set(head, [...(heads.get(head) ?? []), r]);
    }
    const useHeads = heads.size > 1 || !heads.has("");
    if (!useHeads) html += groupLines(set, supported, "");
    else {
      for (const [head, list] of heads) {
        const key = nodeKey(set.id, "h", head);
        const open = expanded.has(key);
        html += `<div class="line"><span><button type="button" class="exp" data-act="expand" data-key="${esc(key)}" aria-expanded="${open}">${
          open ? "▾" : "▸"
        } ${esc(head || "Other")}</button> <span class="dim">· ${list.length} rules</span> ${nodeStatus(list, set)}</span>${toggle(
          `data-act="ids" data-set="${esc(set.id)}" data-key="${esc(key)}"`,
          list,
          `${head} enabled`
        )}</div>`;
        if (open) html += groupLines(set, list, head);
      }
    }
    if (unsupported.length) {
      const key = nodeKey(set.id, "u", "");
      const open = expanded.has(key);
      html += `<div class="line"><span><button type="button" class="exp" data-act="expand" data-key="${esc(key)}" aria-expanded="${open}">${
        open ? "▾" : "▸"
      } Not supported</button> <span class="dim">· ${unsupported.length} rules</span></span><span></span></div>`;
      if (open) {
        html += `<div class="rules">${unsupported
          .map((r) => `<div class="line rule-line"><span>${esc(r.name)} <span class="dim">· ${esc(r.unsupportedReason ?? "")}</span></span><span></span></div>`)
          .join("")}</div>`;
      }
    }
    return `${html}</div></div>`;
  }

  function renderChecks() {
    let html = `<div class="lab"><span>rule sets</span><span><input type="file" id="import-xml" accept=".xml,text/xml" hidden /><button type="button" class="text-link" data-act="import">import xml</button></span></div>`;
    if (!loaded) html += `<div class="empty"><b>Loading rules…</b><span>Reading rule sets from the server.</span></div>`;
    else if (rulesets.length === 0) {
      html += `<div class="empty"><b>No rules yet</b><span>Import a Model Checker checkset (such as IFC-SG), or describe a rule below and Claude will create it.</span></div>`;
    } else html += rulesets.map(setCard).join("");
    html += `<div class="lab"><span>create a rule</span></div>
      <label class="ask"><input id="rule-ask" type="text" placeholder='Describe it — "every room needs a Department"' autocomplete="off" />
      <button type="button" class="text-link" data-act="ask">ask claude ↗</button></label>`;
    deps.checksView.innerHTML = html;
  }

  function idsForKey(set: RulesetView, key: string): RuleView[] {
    const head = decodeURIComponent(key.split(":")[2] ?? "");
    return set.rules.filter((r) => r.supported && (head ? r.group.startsWith(`${head} / `) : !r.group.includes(" / ")));
  }

  async function act(fn: () => Promise<unknown>, done: string) {
    try {
      await fn();
      deps.setStatus(done);
    } catch (error) {
      deps.setStatus(error instanceof Error ? error.message : String(error));
    }
    rulesets = await api.listRules().catch(() => rulesets);
    renderChecks();
    deps.onChange();
  }

  deps.checksView.addEventListener("click", (event) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!el) return;
    const set = rulesets.find((s) => s.id === el.dataset.set);
    switch (el.dataset.act) {
      case "expand": {
        const key = el.dataset.key ?? "";
        if (expanded.has(key)) expanded.delete(key);
        else expanded.add(key);
        renderChecks();
        return;
      }
      case "import":
        (deps.checksView.querySelector("#import-xml") as HTMLInputElement | null)?.click();
        return;
      case "ask":
        void askClaude();
        return;
      case "set":
        if (set) void act(() => api.setEnabled({ rulesetId: set.id }, !set.enabled), `${set.name} ${set.enabled ? "off" : "on"}`);
        return;
      case "group": {
        if (!set) return;
        const list = set.rules.filter((r) => r.group === el.dataset.group && r.supported);
        const next = el.getAttribute("aria-checked") !== "true";
        void act(() => api.setEnabled({ rulesetId: set.id, group: el.dataset.group }, next), `${list.length} rules ${next ? "on" : "off"}`);
        return;
      }
      case "ids": {
        if (!set) return;
        const list = idsForKey(set, el.dataset.key ?? "");
        const next = el.getAttribute("aria-checked") !== "true";
        void act(() => api.setEnabled({ ids: list.map((r) => r.id) }, next), `${list.length} rules ${next ? "on" : "off"}`);
        return;
      }
      case "rule": {
        const rule = set?.rules.find((r) => r.id === el.dataset.rule);
        if (rule) void act(() => api.setEnabled({ ids: [rule.id] }, !rule.enabled), `${rule.name} ${rule.enabled ? "off" : "on"}`);
        return;
      }
    }
  });

  deps.checksView.addEventListener("change", (event) => {
    const el = event.target as HTMLElement;
    if (el.id === "import-xml") {
      const file = (el as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () =>
        void act(async () => {
          const r = await api.importXml(String(reader.result ?? ""));
          deps.setStatus(`Imported ${r.name}: ${r.rules} rules (${r.unsupported} unsupported)`);
        }, `Imported ${file.name}`);
      reader.readAsText(file);
      return;
    }
    if (el.dataset.act === "sev") {
      const set = rulesets.find((s) => s.id === el.dataset.set);
      const rule = set?.rules.find((r) => r.id === el.dataset.rule);
      const severity = (el as HTMLSelectElement).value as Severity;
      if (rule) void act(() => api.upsertRule({ ...rule, severity }), `${rule.name} is now ${severity}`);
    }
  });

  async function askClaude() {
    const input = deps.checksView.querySelector("#rule-ask") as HTMLInputElement | null;
    const description = input?.value.trim() ?? "";
    if (!description) {
      deps.setStatus("Describe the rule first");
      input?.focus();
      return;
    }
    const prompt = `Create a model check rule for the Revit Schedule app (use rules_upsert): ${description}`;
    try {
      if (deps.app.getHostCapabilities()?.message) {
        await deps.app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        deps.setStatus("Sent to Claude — the rule appears here once it's created (refresh 03)");
      } else {
        await navigator.clipboard.writeText(prompt);
        deps.setStatus("Copied — paste it to Claude");
      }
      if (input) input.value = "";
    } catch (error) {
      deps.setStatus(`Couldn't send: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ------------------------------------------------------------------ Run checks

  async function run() {
    if (runningId != null) return;
    try {
      runningId = await api.runChecks();
    } catch (error) {
      deps.setStatus(error instanceof Error ? error.message : String(error));
      return;
    }
    deps.setStatus(`Check run #${runningId} started`);
    deps.onChange();
    const poll = async () => {
      try {
        const res = await api.getResults(runningId ?? undefined);
        latest = res;
        if (res.run?.status === "running") {
          deps.onChange();
          renderActive();
          setTimeout(() => void poll(), POLL_MS);
          return;
        }
        runningId = null;
        rulesets = await api.listRules().catch(() => rulesets);
        loaded = true;
        deps.setStatus(res.run?.status === "failed" ? `Check failed: ${res.run.error}` : `Checks done — ${passingPct(res)}% of rules passing`);
      } catch (error) {
        runningId = null;
        deps.setStatus(error instanceof Error ? error.message : String(error));
      }
      renderActive();
      deps.onChange();
    };
    setTimeout(() => void poll(), POLL_MS);
  }

  // ------------------------------------------------------------------ 04 Dashboard

  function passingPct(res: ResultsView | null) {
    const r = res?.summary?.rules;
    const rated = (r?.pass ?? 0) + (r?.fail ?? 0);
    return rated ? Math.round(((r?.pass ?? 0) / rated) * 100) : 100;
  }

  const meter = (pct: number | null | undefined) =>
    pct == null
      ? `<span class="meter"><span class="bar"></span><span class="pct">—</span></span>`
      : `<span class="meter"><span class="bar"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></span><span class="pct">${pct}%</span></span>`;

  function spark(values: number[]) {
    if (values.length < 2) return "";
    const lo = Math.min(...values) - 2;
    const hi = Math.max(...values) + 2;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 156 + 2).toFixed(1)},${(32 - ((v - lo) / (hi - lo)) * 28).toFixed(1)}`);
    return `<svg class="spark" viewBox="0 0 160 34" preserveAspectRatio="none" aria-label="Rules passing over the last ${values.length} runs"><polyline points="${pts.join(" ")}"/></svg>`;
  }

  function renderDashboard() {
    const view = deps.dashboardView;
    const run = latest?.run;
    if (!loaded && !run) {
      view.innerHTML = `<div class="empty"><b>Loading results…</b><span>Reading the latest check run.</span></div>`;
      return;
    }
    if (!run) {
      view.innerHTML = `<div class="empty"><b>No check results yet</b><span>Choose rules in 03 Checks, then press Run checks.</span></div>`;
      return;
    }
    if (run.status === "running") {
      const p = run.progress;
      view.innerHTML = `<div class="empty"><b>Checking the model…</b><span>${p ? `${esc(p.stage)} ${p.done}/${p.total}` : "Starting"}</span></div>`;
      return;
    }
    if (run.status === "failed") {
      view.innerHTML = `<div class="empty"><b>The last check failed</b><span>${esc(run.error ?? "Unknown error")}</span></div>`;
      return;
    }
    const s = latest!.summary!;
    const trend = (latest!.trend ?? []).map((t) => t.passedPct);
    const pct = passingPct(latest);
    const prev = trend.length > 1 ? trend[trend.length - 2] : null;
    const delta = prev == null ? "first run" : `${pct - prev >= 0 ? "+" : ""}${pct - prev} vs last`;

    let html = `<div class="notice">Run #${run.id} · ${time(run.finishedAt)} · ${s.elementsChecked.toLocaleString()} host elements. Each element is checked on its own — stricter than Autodesk Model Checker, which passes a check when any element matches.</div>`;
    html += `<div class="kpis">
      <div class="card"><div class="lab" style="margin:0"><span>rules passing</span><span class="dim">${s.rules.pass} pass · ${s.rules.fail} fail · ${s.rules.na} n/a</span></div>
        <div style="display:flex;align-items:flex-end;gap:10px;margin-top:6px"><span class="big">${pad3(pct)}%</span><span class="delta">${delta}</span></div>
        ${spark(trend)}</div>
      <div class="card"><div class="lab" style="margin:0"><span>issues · failing elements</span></div><div class="rows">
        <div class="line"><span>${dot("error")}errors</span><span class="dim">${pad3(s.bySeverity.error)}</span></div>
        <div class="line"><span>${dot("warning")}warnings</span><span class="dim">${pad3(s.bySeverity.warning)}</span></div>
        <div class="line"><span>${dot("info")}info</span><span class="dim">${pad3(s.bySeverity.info)}</span></div>
      </div></div>
    </div>`;

    const cats = Object.entries(s.categories).sort((a, b) => b[1].host - a[1].host).slice(0, 10);
    const linked = Object.values(s.categories).reduce((n, c) => n + c.linked, 0);
    html += `<div class="lab"><span>elements · compliance by category</span><span>linked ${linked.toLocaleString()} (not checked)</span></div><div class="rows">`;
    for (const [ost, c] of cats) {
      const name = deps.categoryName(ost);
      html += `<div class="line"><span>${deps.categoryGlyph(name)}${esc(name)} <span class="dim">${c.host.toLocaleString()}${
        c.linked ? ` · +${c.linked.toLocaleString()} linked` : ""
      }</span></span>${meter(c.compliantPct)}</div>`;
    }
    html += `</div>`;

    html += `<div class="lab"><span>parameters · fill rate where required</span><span>lowest first</span></div><div class="rows">`;
    if (s.parameters.length === 0) html += `<div class="line"><span class="dim">No required parameters in scope.</span><span></span></div>`;
    for (const p of s.parameters.slice(0, 8)) {
      html += `<div class="line"><span>${esc(p.name)} <span class="dim">· ${esc(p.where.join(", "))}</span></span>${meter(p.fillPct)}</div>`;
    }
    html += `</div>`;

    const fixes = (latest!.fixes ?? []).slice(0, MAX_FIXES);
    html += `<div class="lab"><span>fixes · ranked by elements affected</span><span>${fixes.length} shown</span></div>`;
    if (fixes.length === 0) html += `<div class="empty"><b>Nothing to fix</b><span>Every checked rule passes.</span></div>`;
    for (const f of fixes) {
      const where = f.group.split(" / ").slice(-1)[0];
      html += `<div class="card fix"><div>${dot(f.severity)}<b>${esc(f.name)}</b> <span class="dim">· ${esc(where)} · ${f.failedCount.toLocaleString()} failing</span></div><p>${esc(
        f.fix ?? ""
      )}</p></div>`;
    }
    view.innerHTML = html;
  }

  // ------------------------------------------------------------------ dock + model context

  function dockLabel() {
    if (runningId != null) {
      const p = latest?.run?.status === "running" ? latest.run.progress : null;
      return p ? `checking · ${p.stage} ${p.done}/${p.total}` : "checking…";
    }
    if (!loaded) return "rules";
    const last = latest?.run?.status === "done" ? `last run ${time(latest.run.finishedAt)}` : "not run yet";
    return `${enabledCount()} rules on · ${last}`;
  }

  function contextLines(): string[] {
    if (!latest?.run) return [];
    const s = latest.summary;
    const lines = [`Last check run #${latest.run.id} (${latest.run.status})`];
    if (latest.run.status === "done" && s) {
      lines.push(
        `Checks: ${s.rules.pass} pass · ${s.rules.fail} fail · ${s.rules.na} n/a rules (${passingPct(latest)}% passing); issues: ${s.bySeverity.error} errors, ${s.bySeverity.warning} warnings`
      );
      for (const f of (latest.fixes ?? []).slice(0, 5)) lines.push(`- ${f.name}: ${f.failedCount} failing`);
    }
    return lines;
  }

  return {
    show,
    refresh,
    run,
    dockLabel,
    contextLines,
    isRunning: () => runningId != null,
    enabledCount: () => (loaded ? enabledCount() : null),
  };
}
