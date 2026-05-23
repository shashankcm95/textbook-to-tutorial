/**
 * src/db/schema.ts — Drizzle ORM definitions for TB_to_Tutorial_converter.
 *
 * 7 tables (locked in PHASE-1-SYNTHESIS.md):
 *   users → tutorials → chapters → questions
 *                                 → flashcards → srs_reviews
 *                     → parses_cost (telemetry; nullable chapter_id)
 *
 * Schema deltas from Phase 1 synthesis:
 *   - chapters: +5 observational fields per riley HIGH-2
 *     (viewed_at, scroll_depth_pct, time_spent_seconds, last_quiz_*).
 *     Boolean is_read REMAINS — the simple completion check stays.
 *   - srs_reviews: +2 nullable fields per riley HIGH-1 PARTIAL
 *     (ease_factor, interval_days) for future SM-2/FSRS migration without
 *     ALTER TABLE pain. Null until SM-2 enabled.
 *   - parses_cost: +validation_drop_count per ari HIGH-3 — counts Q/flashcards
 *     dropped during source_paragraph_ref validation per chapter.
 *
 * SRP audit (per kb:architecture/crosscut/single-responsibility):
 *   - users / tutorials / chapters split: each owns one consistency unit.
 *   - flashcards vs srs_reviews split: flashcards mutate on LLM regenerate
 *     (one change-reason — content authoring); srs_reviews mutate on every
 *     user grading (different change-reason — review state).
 *     Folding them would couple two change-pressures (per Clean Code ch 10
 *     reason-to-change test). See finding HIGH-2 in this persona's report.
 *
 * Migration strategy (per ari design):
 *   - Initial migration ships hand-written SQL at `drizzle/migrations/0000_initial.sql`.
 *     Subsequent migrations generated via `drizzle-kit generate` from this file.
 *   - SQLite supports only ADD COLUMN ALTER; breaking changes require
 *     copy-and-swap pattern. The riley HIGH-1/HIGH-2 columns above are
 *     ADDITIVE — schema-additive principle (per Phase 1 synthesis).
 *
 * Type imports: `SourceParagraph` shape is owned by jules in `src/lib/types.ts`
 *   (per Phase 2 Wave 1 handoff). Stored as JSON-encoded text in
 *   chapters.source_paragraphs_json. Consumers must `JSON.parse` + cast.
 */

import { sqliteTable, text, integer, real, index, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────────────────────────
// users — anonymous session-cookie-keyed accounts (no email/password in MVP)
// ─────────────────────────────────────────────────────────────────────────────
export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),                                       // uuid v4 (caller-generated)
    sessionCookieHash: text('session_cookie_hash').notNull().unique(), // sha256 of signed session cookie
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    byCookie: index('idx_users_cookie').on(t.sessionCookieHash),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// tutorials — one row per ingested PDF
// status state machine: ingesting → parsing → ready-to-generate
//                                            ↓
//                                 generating → complete | error
// ─────────────────────────────────────────────────────────────────────────────
export const TUTORIAL_STATUSES = [
  'ingesting',
  'parsing',
  'ready-to-generate',
  'generating',
  'complete',
  'error',
] as const;

export const tutorials = sqliteTable(
  'tutorials',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceS3Url: text('source_s3_url').notNull(),
    sourcePdfSha256: text('source_pdf_sha256'),                        // null until fetched + hashed
    status: text('status', { enum: TUTORIAL_STATUSES }).notNull(),
    errorMessage: text('error_message'),                               // populated when status='error'
    totalPages: integer('total_pages'),                                // null until parsed
    totalChapters: integer('total_chapters'),                          // null until parsed
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    byUser: index('idx_tutorials_user').on(t.userId),
    byStatus: index('idx_tutorials_status').on(t.status),
  }),
);

export type Tutorial = typeof tutorials.$inferSelect;
export type NewTutorial = typeof tutorials.$inferInsert;
export type TutorialStatus = (typeof TUTORIAL_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// chapters — one row per detected chapter in a tutorial
// Phase 1 status enum extended with 'partial' to support per-chapter degraded
// outcomes (e.g., narrative complete but some questions dropped at validation
// — see parses_cost.validation_drop_count).
// ─────────────────────────────────────────────────────────────────────────────
export const CHAPTER_STATUSES = [
  'pending',
  'generating',
  'complete',
  'failed',
  'partial',
] as const;

export const chapters = sqliteTable(
  'chapters',
  {
    id: text('id').primaryKey(),
    tutorialId: text('tutorial_id')
      .notNull()
      .references(() => tutorials.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull(),                             // 0-based position
    title: text('title').notNull(),
    narrative: text('narrative'),                                      // populated on generation complete
    sourcePageStart: integer('source_page_start').notNull(),
    sourcePageEnd: integer('source_page_end').notNull(),
    // JSON array of SourceParagraph objects (see src/lib/types.ts).
    // Stored as text; parsed at read time. JSON-blob trade-off:
    //   + zero-join read path for proof-citation rendering
    //   - not query-able (no WHERE on paragraph contents)
    //   - schema drift caught only at parse time (not by SQL)
    // Rationale: rendering needs ALL paragraphs anyway; never filter SQL-side.
    sourceParagraphsJson: text('source_paragraphs_json').notNull(),
    status: text('status', { enum: CHAPTER_STATUSES }).notNull(),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),

    // ── riley HIGH-2 absorb (observational completion model) ──
    // is_read above stays as the simple boolean signal. These fields add
    // richer observational data for future analytics (retention curves,
    // engagement heatmaps). All nullable — populated lazily by client.
    viewedAt: integer('viewed_at', { mode: 'timestamp' }),
    scrollDepthPct: real('scroll_depth_pct'),                          // 0.0 – 1.0
    timeSpentSeconds: integer('time_spent_seconds').notNull().default(0),
    lastQuizAttemptAt: integer('last_quiz_attempt_at', { mode: 'timestamp' }),
    lastQuizScore: real('last_quiz_score'),                            // 0.0 – 1.0
  },
  (t) => ({
    byTutorialOrdinal: index('idx_chapters_tutorial_ordinal').on(t.tutorialId, t.ordinal),
  }),
);

export type Chapter = typeof chapters.$inferSelect;
export type NewChapter = typeof chapters.$inferInsert;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// questions — multiple-choice questions for each chapter
// CHECK constraint on correct_index BETWEEN 0 AND 3 enforced in SQL migration
// (Drizzle TS-level lacks CHECK constraint support; SQL is authoritative).
// ─────────────────────────────────────────────────────────────────────────────
export const questions = sqliteTable(
  'questions',
  {
    id: text('id').primaryKey(),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    prompt: text('prompt').notNull(),
    optionsJson: text('options_json').notNull(),                       // JSON: ["A...", "B...", "C...", "D..."]
    correctIndex: integer('correct_index').notNull(),                  // 0..3 (CHECK in SQL)
    explanation: text('explanation').notNull(),
    sourceParagraphRef: text('source_paragraph_ref').notNull(),        // "pageN:paragraphM"
  },
  (t) => ({
    byChapter: index('idx_questions_chapter').on(t.chapterId),
  }),
);

export type Question = typeof questions.$inferSelect;
export type NewQuestion = typeof questions.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// flashcards — front/back review cards for each chapter
// SRP-split from srs_reviews: content authoring vs user review state
// (see file-level comment + this persona's report finding HIGH-2).
// ─────────────────────────────────────────────────────────────────────────────
export const flashcards = sqliteTable(
  'flashcards',
  {
    id: text('id').primaryKey(),
    chapterId: text('chapter_id')
      .notNull()
      .references(() => chapters.id, { onDelete: 'cascade' }),
    front: text('front').notNull(),
    back: text('back').notNull(),
    sourceParagraphRef: text('source_paragraph_ref').notNull(),        // "pageN:paragraphM"
  },
  (t) => ({
    byChapter: index('idx_flashcards_chapter').on(t.chapterId),
  }),
);

export type Flashcard = typeof flashcards.$inferSelect;
export type NewFlashcard = typeof flashcards.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// srs_reviews — per-(flashcard, user) review state (Leitner 5-box)
// Composite PK (flashcardId, userId) — one review record per user per card.
//
// Leitner box semantics (see src/lib/srs/leitner.ts BOX_INTERVAL_DAYS):
//   box=1 → due in 1 day  (least confident, fresh / reset)
//   box=2 → due in 1 day  (just promoted from 1)
//   box=3 → due in 3 days
//   box=4 → due in 7 days
//   box=5 → due in 14-30 days (most confident)
//
// riley HIGH-1 PARTIAL absorb: ease_factor + interval_days columns are
// nullable, populated only if/when SM-2/FSRS is enabled in a future phase.
// Keeps the SM-2 migration ADDITIVE (no ALTER required at swap time).
// ─────────────────────────────────────────────────────────────────────────────
export const srsReviews = sqliteTable(
  'srs_reviews',
  {
    flashcardId: text('flashcard_id')
      .notNull()
      .references(() => flashcards.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    box: integer('box').notNull().default(1),                          // 1..5 (CHECK in SQL)
    lastReviewedAt: integer('last_reviewed_at', { mode: 'timestamp' }),
    dueAt: integer('due_at', { mode: 'timestamp' }).notNull(),
    consecutiveCorrect: integer('consecutive_correct').notNull().default(0),

    // ── riley HIGH-1 PARTIAL absorb (SM-2 / FSRS future-proofing) ──
    easeFactor: real('ease_factor'),                                   // SM-2 EF; null until enabled
    intervalDays: real('interval_days'),                               // SM-2 I; null until enabled
  },
  (t) => ({
    pk: primaryKey({ columns: [t.flashcardId, t.userId] }),
    // idx_srs_due — primary query path: "what's due for this user now?"
    // Composite (userId, dueAt) supports range scan WHERE userId=? AND dueAt<=?
    byDue: index('idx_srs_due').on(t.userId, t.dueAt),
  }),
);

export type SrsReview = typeof srsReviews.$inferSelect;
export type NewSrsReview = typeof srsReviews.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// parses_cost — telemetry / cost-cap evidence
// chapter_id NULL → parse-level row (whole PDF parsing cost)
// chapter_id NOT NULL → chapter-level row (per-chapter OpenAI call cost)
//
// validation_drop_count (ari HIGH-3 absorb): counts questions/flashcards
// dropped at validation (source_paragraph_ref unmatched) per chapter. Drives
// the chapter.status='partial' decision in ml-engineer's streaming worker.
// ─────────────────────────────────────────────────────────────────────────────
export const parsesCost = sqliteTable(
  'parses_cost',
  {
    id: text('id').primaryKey(),
    tutorialId: text('tutorial_id')
      .notNull()
      .references(() => tutorials.id, { onDelete: 'cascade' }),
    chapterId: text('chapter_id').references(() => chapters.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),                                    // 'gpt-4o-mini' / 'gpt-4o' / etc
    promptTokens: integer('prompt_tokens').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),                               // computed at insert time
    validationDropCount: integer('validation_drop_count').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => ({
    byTutorial: index('idx_cost_tutorial').on(t.tutorialId),
  }),
);

export type ParseCost = typeof parsesCost.$inferSelect;
export type NewParseCost = typeof parsesCost.$inferInsert;

// ─────────────────────────────────────────────────────────────────────────────
// Re-export aggregate — convenience for `import * as schema from './schema'`
// (drizzle migrator requires the schema namespace at runtime).
// ─────────────────────────────────────────────────────────────────────────────
export const schema = {
  users,
  tutorials,
  chapters,
  questions,
  flashcards,
  srsReviews,
  parsesCost,
};
