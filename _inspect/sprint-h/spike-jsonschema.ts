/**
 * _inspect/sprint-h/spike-jsonschema.ts — Sprint H Wave 0.5 spike (THROWAWAY)
 *
 * Empirically tests whether OpenAI strict-mode response_format accepts two
 * known-friction JSON-Schema-2020 constructs from the F.1 Zod schema:
 *
 *   Q1: `additionalProperties: { type: 'string' }` (rows of ComparisonTable)
 *   Q2: `$ref` recursion (DecisionTree.root → DecisionNode → yes/no → ...)
 *
 * Also confirms the two flat-list fallbacks work under strict mode.
 *
 * Each case: invoke gpt-4o-mini with the schema as response_format, prompt
 * for a worked example, capture { acceptedAtCompile, errorMessage?, output?,
 * outputValid?, latencyMs, costUsd }. Print a markdown summary to stdout.
 *
 * NOT shipped. Lives under _inspect/ which is untracked.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import {
  ComparisonTableSchema,
  DecisionTreeSchema,
} from '../../src/lib/diagrams/schema';

// ---------------------------------------------------------------------------
// Pricing: gpt-4o-mini per-token cost (USD), Jan 2025 published.
// Input $0.150 / 1M tokens; Output $0.600 / 1M tokens.
// ---------------------------------------------------------------------------
const INPUT_PRICE_PER_TOKEN = 0.15 / 1_000_000;
const OUTPUT_PRICE_PER_TOKEN = 0.6 / 1_000_000;
const MODEL = 'gpt-4o-mini';

function computeCost(promptTokens: number, completionTokens: number): number {
  return promptTokens * INPUT_PRICE_PER_TOKEN + completionTokens * OUTPUT_PRICE_PER_TOKEN;
}

// ---------------------------------------------------------------------------
// Case 1 — ComparisonTable with additionalProperties: { type: 'string' }
// ---------------------------------------------------------------------------
//
// Natural JSON-Schema 2020 form of z.record(z.string()) for rows.
// `additionalProperties: false` may be required at top-level by strict mode;
// the question is whether strict mode accepts a *typed* additionalProperties
// for nested rows-object values.

const case1Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    diagrams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'ComparisonTable' },
          title: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
            minItems: 1,
            maxItems: 20,
          },
        },
        required: ['kind', 'title', 'columns', 'rows'],
      },
    },
  },
  required: ['diagrams'],
};

// ---------------------------------------------------------------------------
// Case 2 — ComparisonTable with flat-list fallback ({column, value}[])
// ---------------------------------------------------------------------------
//
// Each row is `Array<{ column: string, value: string }>` — wire shape; the
// (future) translator rebuilds the Record<string,string> Zod expects.

const case2Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    diagrams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'ComparisonTable' },
          title: { type: 'string' },
          columns: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                cells: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      column: { type: 'string' },
                      value: { type: 'string' },
                    },
                    required: ['column', 'value'],
                  },
                },
              },
              required: ['cells'],
            },
            minItems: 1,
            maxItems: 20,
          },
        },
        required: ['kind', 'title', 'columns', 'rows'],
      },
    },
  },
  required: ['diagrams'],
};

// ---------------------------------------------------------------------------
// Case 3 — DecisionTree with $ref recursion
// ---------------------------------------------------------------------------

const case3Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    diagrams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'DecisionTree' },
          title: { type: 'string' },
          root: { $ref: '#/$defs/DecisionNode' },
        },
        required: ['kind', 'title', 'root'],
      },
    },
  },
  required: ['diagrams'],
  $defs: {
    DecisionNode: {
      type: 'object',
      additionalProperties: false,
      properties: {
        question: { type: 'string' },
        leaf: { type: 'string' },
        yes: { $ref: '#/$defs/DecisionNode' },
        no: { $ref: '#/$defs/DecisionNode' },
      },
      // strict mode requires all properties listed in required:
      required: ['question', 'leaf', 'yes', 'no'],
    },
  },
};

// ---------------------------------------------------------------------------
// Case 4 — DecisionTree with adjacency-list fallback (nodes[])
// ---------------------------------------------------------------------------

const case4Schema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    diagrams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', const: 'DecisionTree' },
          title: { type: 'string' },
          rootId: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                question: { type: 'string' },
                leaf: { type: 'string' },
                yesId: { type: 'string' },
                noId: { type: 'string' },
              },
              required: ['id', 'question', 'leaf', 'yesId', 'noId'],
            },
          },
        },
        required: ['kind', 'title', 'rootId', 'nodes'],
      },
    },
  },
  required: ['diagrams'],
};

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface CaseSpec {
  id: string;
  description: string;
  schema: Record<string, unknown>;
  prompt: string;
  zodValidate: (entry: unknown) => { ok: boolean; error?: string };
}

interface CaseResult {
  id: string;
  description: string;
  acceptedAtCompile: boolean;
  errorMessage?: string;
  outputJson?: unknown;
  outputValid?: boolean;
  outputZodError?: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
}

const cases: CaseSpec[] = [
  {
    id: 'case1',
    description: "ComparisonTable rows with additionalProperties: { type: 'string' }",
    schema: case1Schema,
    prompt:
      'Produce exactly one ComparisonTable diagram comparing three database engines (PostgreSQL, MongoDB, Redis) across the columns Engine, Data Model, Consistency. Rows are objects keyed by column name with string values.',
    zodValidate: (entry: unknown) => {
      const r = ComparisonTableSchema.safeParse(entry);
      return r.success ? { ok: true } : { ok: false, error: r.error.message };
    },
  },
  {
    id: 'case2',
    description: 'ComparisonTable rows as flat-list fallback ({column, value}[])',
    schema: case2Schema,
    prompt:
      'Produce exactly one ComparisonTable diagram comparing three database engines (PostgreSQL, MongoDB, Redis) across the columns Engine, Data Model, Consistency. Each row contains a "cells" array of {column, value} objects.',
    zodValidate: (entry: unknown) => {
      // Translate wire → Zod input then validate.
      if (
        !entry ||
        typeof entry !== 'object' ||
        !Array.isArray((entry as { rows?: unknown[] }).rows)
      ) {
        return { ok: false, error: 'no rows array' };
      }
      const wire = entry as {
        kind: string;
        title?: string;
        columns: string[];
        rows: Array<{ cells: Array<{ column: string; value: string }> }>;
      };
      const translated = {
        kind: wire.kind,
        title: wire.title,
        columns: wire.columns,
        rows: wire.rows.map((r) => {
          const obj: Record<string, string> = {};
          for (const c of r.cells) obj[c.column] = c.value;
          return obj;
        }),
      };
      const r = ComparisonTableSchema.safeParse(translated);
      return r.success ? { ok: true } : { ok: false, error: r.error.message };
    },
  },
  {
    id: 'case3',
    description: 'DecisionTree with $ref recursion',
    schema: case3Schema,
    prompt:
      'Produce exactly one DecisionTree diagram representing how to choose between SQL, NoSQL document, and key-value store. Internal nodes have a question and yes/no children; leaves have a leaf string. Tree depth 2-3 levels.',
    zodValidate: (entry: unknown) => {
      // Strict mode forces all keys present even when irrelevant; collapse
      // empty-string leaf vs. real question via "if leaf is empty, drop it"
      // pre-Zod cleanup (this is roughly what the translator would do).
      function clean(node: unknown): unknown {
        if (!node || typeof node !== 'object') return node;
        const n = node as Record<string, unknown>;
        const isLeaf =
          typeof n.leaf === 'string' &&
          n.leaf.length > 0 &&
          (!n.question || (typeof n.question === 'string' && n.question.length === 0));
        if (isLeaf) return { leaf: n.leaf };
        return {
          question: n.question,
          yes: clean(n.yes),
          no: clean(n.no),
        };
      }
      if (!entry || typeof entry !== 'object') return { ok: false, error: 'not object' };
      const e = entry as { kind: string; title?: string; root: unknown };
      const translated = { kind: e.kind, title: e.title, root: clean(e.root) };
      const r = DecisionTreeSchema.safeParse(translated);
      return r.success ? { ok: true } : { ok: false, error: r.error.message };
    },
  },
  {
    id: 'case4',
    description: 'DecisionTree as adjacency-list fallback (nodes[])',
    schema: case4Schema,
    prompt:
      'Produce exactly one DecisionTree diagram representing how to choose between SQL, NoSQL document, and key-value store. Provide a nodes[] adjacency list with rootId pointing at the root node id. Each node has id and the four optional-but-required strings: question, leaf, yesId, noId (empty string when not applicable). Tree depth 2-3 levels.',
    zodValidate: (entry: unknown) => {
      if (!entry || typeof entry !== 'object') return { ok: false, error: 'not object' };
      const w = entry as {
        kind: string;
        title?: string;
        rootId: string;
        nodes: Array<{
          id: string;
          question: string;
          leaf: string;
          yesId: string;
          noId: string;
        }>;
      };
      const byId = new Map(w.nodes.map((n) => [n.id, n]));
      function build(id: string): unknown {
        const n = byId.get(id);
        if (!n) return { leaf: 'MISSING' };
        if (n.leaf && n.leaf.length > 0) return { leaf: n.leaf };
        return {
          question: n.question,
          yes: build(n.yesId),
          no: build(n.noId),
        };
      }
      const translated = { kind: w.kind, title: w.title, root: build(w.rootId) };
      const r = DecisionTreeSchema.safeParse(translated);
      return r.success ? { ok: true } : { ok: false, error: r.error.message };
    },
  },
];

async function runCase(client: OpenAI, spec: CaseSpec): Promise<CaseResult> {
  const t0 = Date.now();
  const result: CaseResult = {
    id: spec.id,
    description: spec.description,
    acceptedAtCompile: false,
    promptTokens: 0,
    completionTokens: 0,
    latencyMs: 0,
    costUsd: 0,
  };
  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You produce a JSON object matching the supplied JSON Schema. The object has a single key "diagrams" containing an array with exactly one diagram. No prose.',
        },
        { role: 'user', content: spec.prompt },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'spike_payload',
          strict: true,
          // OpenAI's SDK types are narrow here; cast through unknown.
          schema: spec.schema as unknown as Record<string, unknown>,
        },
      },
    });
    result.acceptedAtCompile = true;
    result.promptTokens = resp.usage?.prompt_tokens ?? 0;
    result.completionTokens = resp.usage?.completion_tokens ?? 0;
    result.costUsd = computeCost(result.promptTokens, result.completionTokens);
    const content = resp.choices[0]?.message?.content ?? '';
    try {
      const parsed = JSON.parse(content) as { diagrams?: unknown[] };
      result.outputJson = parsed;
      const firstEntry = Array.isArray(parsed.diagrams) ? parsed.diagrams[0] : undefined;
      if (firstEntry === undefined) {
        result.outputValid = false;
        result.outputZodError = 'no diagrams[0] in output';
      } else {
        const v = spec.zodValidate(firstEntry);
        result.outputValid = v.ok;
        if (!v.ok) result.outputZodError = v.error;
      }
    } catch (e) {
      result.outputValid = false;
      result.outputZodError = `JSON.parse failed: ${(e as Error).message}`;
    }
  } catch (e) {
    const err = e as { status?: number; message?: string; error?: { message?: string } };
    result.acceptedAtCompile = false;
    result.errorMessage = err.error?.message ?? err.message ?? String(e);
  } finally {
    result.latencyMs = Date.now() - t0;
  }
  return result;
}

function fmtBool(b: boolean | undefined): string {
  if (b === undefined) return 'n/a';
  return b ? 'YES' : 'NO';
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(6)}`;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY missing — source .env first.');
    process.exit(1);
  }
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 60_000 });

  console.log(`# Spike: JSON-Schema strict-mode compatibility (model=${MODEL})\n`);

  const results: CaseResult[] = [];
  for (const spec of cases) {
    process.stderr.write(`[run] ${spec.id} — ${spec.description}\n`);
    const r = await runCase(client, spec);
    results.push(r);
    process.stderr.write(
      `       acceptedAtCompile=${fmtBool(r.acceptedAtCompile)} outputValid=${fmtBool(
        r.outputValid,
      )} latency=${r.latencyMs}ms cost=${fmtUsd(r.costUsd)}\n`,
    );
    if (r.errorMessage) {
      process.stderr.write(`       error: ${r.errorMessage}\n`);
    }
    if (r.outputZodError) {
      process.stderr.write(`       zodError: ${r.outputZodError.slice(0, 200)}\n`);
    }
  }

  // ---- Markdown summary table -------------------------------------------
  console.log('## Test matrix\n');
  console.log(
    '| Case | Construct | Compile? | Zod-valid? | Latency | Cost | Error / Zod-err |',
  );
  console.log(
    '|------|-----------|----------|------------|---------|------|-----------------|',
  );
  for (const r of results) {
    const err = (r.errorMessage ?? r.outputZodError ?? '').slice(0, 80).replace(/\|/g, '\\|');
    console.log(
      `| ${r.id} | ${r.description} | ${fmtBool(r.acceptedAtCompile)} | ${fmtBool(
        r.outputValid,
      )} | ${r.latencyMs}ms | ${fmtUsd(r.costUsd)} | ${err} |`,
    );
  }

  // ---- Detail: each case's output sample --------------------------------
  console.log('\n## Output samples\n');
  for (const r of results) {
    console.log(`### ${r.id}\n`);
    if (r.errorMessage) {
      console.log('**Schema rejected at compile.** Error:\n');
      console.log('```');
      console.log(r.errorMessage);
      console.log('```\n');
      continue;
    }
    console.log('```json');
    console.log(JSON.stringify(r.outputJson, null, 2));
    console.log('```\n');
    if (r.outputZodError) {
      console.log(`**Zod validation error:** ${r.outputZodError}\n`);
    }
  }

  const totalCost = results.reduce((s, r) => s + r.costUsd, 0);
  console.log(`\n## Total spike cost: ${fmtUsd(totalCost)}\n`);
}

main().catch((e) => {
  console.error('Spike crashed:', e);
  process.exit(1);
});
