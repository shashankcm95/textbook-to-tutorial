/**
 * Follow-up spike — isolate the Q1 and Q2 unknowns more precisely.
 *
 * Q1 follow-up: the initial case1 error was "Extra required key 'rows' supplied"
 * which is ambiguous. Reduce to the minimal: one object with one rows-like
 * property using additionalProperties:{type:'string'}, see if OpenAI accepts.
 *
 * Q2 follow-up: case3 timed out (60s). Could be schema rejected silently OR
 * real strict-mode-pathological recursion. Retry with 180s timeout to
 * distinguish "rejected" vs "slow". Also try without additionalProperties:false
 * on the recursive node (a known strict-mode incompatibility per OpenAI docs).
 */

import OpenAI from 'openai';

const MODEL = 'gpt-4o-mini';

interface TrialResult {
  id: string;
  description: string;
  ok: boolean;
  errorMessage?: string;
  output?: unknown;
  latencyMs: number;
}

async function trial(
  client: OpenAI,
  id: string,
  description: string,
  schema: Record<string, unknown>,
  userPrompt: string,
  timeoutMs = 180_000,
): Promise<TrialResult> {
  const t0 = Date.now();
  try {
    const resp = await client.chat.completions.create(
      {
        model: MODEL,
        messages: [
          {
            role: 'system',
            content: 'Produce JSON matching the schema. No prose.',
          },
          { role: 'user', content: userPrompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'trial_payload',
            strict: true,
            schema: schema as unknown as Record<string, unknown>,
          },
        },
      },
      { timeout: timeoutMs },
    );
    const content = resp.choices[0]?.message?.content ?? '';
    return {
      id,
      description,
      ok: true,
      output: JSON.parse(content),
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    const err = e as { status?: number; message?: string; error?: { message?: string } };
    return {
      id,
      description,
      ok: false,
      errorMessage: err.error?.message ?? err.message ?? String(e),
      latencyMs: Date.now() - t0,
    };
  }
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('OPENAI_API_KEY missing');
    process.exit(1);
  }
  const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 180_000 });

  const trials: Array<{ id: string; description: string; schema: Record<string, unknown>; prompt: string; timeout?: number }> = [
    // Q1a — minimal additionalProperties:{type:string} on a single object.
    // Strip the array context so we isolate the construct.
    {
      id: 'Q1a',
      description: 'Top-level wrapper with rows-object using additionalProperties:{type:string}',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          row: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
        },
        required: ['row'],
      },
      prompt: 'Produce a row with keys "engine"="postgres" and "type"="sql".',
    },
    // Q1b — wrap row in an array (same as case1's failing context).
    {
      id: 'Q1b',
      description: 'Array of rows, each row open-object additionalProperties:{type:string}',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: { type: 'string' },
            },
          },
        },
        required: ['rows'],
      },
      prompt: 'Produce 2 rows, each with two string-keyed string fields.',
    },
    // Q2a — recursion with $ref, longer timeout to distinguish reject vs slow.
    {
      id: 'Q2a',
      description: 'DecisionTree $ref recursion, full strict mode, 180s timeout',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          root: { $ref: '#/$defs/Node' },
        },
        required: ['root'],
        $defs: {
          Node: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: { type: 'string' },
              leaf: { type: 'string' },
              yes: { $ref: '#/$defs/Node' },
              no: { $ref: '#/$defs/Node' },
            },
            required: ['question', 'leaf', 'yes', 'no'],
          },
        },
      },
      prompt: 'Produce a 2-level decision tree about choosing a DB. Internal nodes have question + yes/no; leaves have leaf string. Use empty string "" for fields that do not apply.',
      timeout: 180_000,
    },
  ];

  console.log(`# Follow-up spike (model=${MODEL})\n`);
  for (const t of trials) {
    process.stderr.write(`[run] ${t.id} — ${t.description}\n`);
    const r = await trial(client, t.id, t.description, t.schema, t.prompt, t.timeout);
    process.stderr.write(`       ok=${r.ok} latency=${r.latencyMs}ms\n`);
    console.log(`## ${r.id} — ${r.description}\n`);
    console.log(`- ok: **${r.ok}**`);
    console.log(`- latency: ${r.latencyMs}ms`);
    if (r.errorMessage) {
      console.log(`- error: \`${r.errorMessage}\``);
    }
    if (r.output) {
      console.log('- output:');
      console.log('```json');
      console.log(JSON.stringify(r.output, null, 2));
      console.log('```');
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('crashed', e);
  process.exit(1);
});
