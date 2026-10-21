import { randomUUID } from "node:crypto";
import { z } from "zod";

export const SEVERITIES = ["error", "warning", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const OPS = [
  "defined",
  "notDefined",
  "hasValue",
  "isEmpty",
  "equals",
  "notEquals",
  "contains",
  "matches",
  "gt",
  "lt",
] as const;
export type Op = (typeof OPS)[number];

const VALUE_OPS: ReadonlySet<Op> = new Set(["equals", "notEquals", "contains", "matches", "gt", "lt"]);

export type Condition = { param: string; op: Op; value?: string; caseInsensitive?: boolean };

export type Rule = {
  id: string;
  rulesetId: string;
  group: string;
  name: string;
  description?: string;
  severity: Severity;
  enabled: boolean;
  scope: {
    categories: string[];
    elementKind: "instance" | "type" | "any";
    where: Condition[];
  };
  require: Condition[];
  fix?: string;
  source: { kind: "model-checker-xml" | "claude" | "manual"; file?: string };
};

const ConditionSchema = z
  .object({
    param: z.string().min(1),
    op: z.enum(OPS),
    value: z.string().optional(),
    caseInsensitive: z.boolean().optional(),
  })
  .superRefine((c, ctx) => {
    if (VALUE_OPS.has(c.op) && c.value == null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${c.op}" on "${c.param}" needs a value` });
      return;
    }
    if (c.op === "matches" && c.value != null) {
      try {
        new RegExp(c.value);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid regular expression for "${c.param}": ${c.value}` });
      }
    }
    if ((c.op === "gt" || c.op === "lt") && c.value != null && !Number.isFinite(Number(c.value))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${c.op}" on "${c.param}" needs a numeric value` });
    }
  });

export const RuleSchema = z.object({
  id: z.string().min(1).optional(),
  rulesetId: z.string().min(1),
  group: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  severity: z.enum(SEVERITIES),
  enabled: z.boolean().default(true),
  scope: z.object({
    categories: z
      .array(z.string().regex(/^OST_\w+$/, "Categories must be BuiltInCategory names such as OST_Doors"))
      .min(1, "At least one category is required"),
    elementKind: z.enum(["instance", "type", "any"]),
    where: z.array(ConditionSchema).default([]),
  }),
  require: z.array(ConditionSchema).min(1, "At least one required condition is needed"),
  fix: z.string().optional(),
  source: z.object({
    kind: z.enum(["model-checker-xml", "claude", "manual"]),
    file: z.string().optional(),
  }),
});

/** Validate rules one by one; missing ids get a UUID. Errors carry the input index. */
export function validateRules(input: unknown[]): { ok: Rule[]; errors: { index: number; message: string }[] } {
  const ok: Rule[] = [];
  const errors: { index: number; message: string }[] = [];
  input.forEach((raw, index) => {
    const parsed = RuleSchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
        .join("; ");
      errors.push({ index, message });
      return;
    }
    ok.push({ ...parsed.data, id: parsed.data.id ?? randomUUID() } as Rule);
  });
  return { ok, errors };
}
