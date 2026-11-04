import { sql } from "drizzle-orm";
import {
  AnyPgColumn,
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export type FileVersion = { fileId: string; sha256: string };

export type AssignableUser = {
  accountId: string;
  displayName: string;
  email: string | null;
};

export const users = pgTable("users", {
  id: id(),
  atlassianAccountId: text("atlassian_account_id").notNull().unique(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  accessTokenEnc: text("access_token_enc").notNull(),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const providerProfiles = pgTable("provider_profiles", {
  id: id(),
  ownerUserId: uuid("owner_user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKeyEnc: text("api_key_enc").notNull(),
  model: text("model").notNull(),
  supportsJsonMode: boolean("supports_json_mode").notNull().default(false),
  contextTokens: integer("context_tokens").notNull().default(128000),
  createdAt: createdAt(),
});

export const projects = pgTable(
  "projects",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    cloudId: text("cloud_id").notNull(),
    siteUrl: text("site_url").notNull(),
    jiraProjectKey: text("jira_project_key").notNull(),
    providerProfileId: uuid("provider_profile_id").references(() => providerProfiles.id),
    retentionDays: integer("retention_days").notNull().default(7),
    createdAt: createdAt(),
  },
  (t) => [unique("projects_cloud_key_unique").on(t.cloudId, t.jiraProjectKey)],
);

export const projectFiles = pgTable("project_files", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"guideline" | "routing">().notNull(),
  filename: text("filename").notNull(),
  content: text("content").notNull(),
  sha256: text("sha256").notNull(),
  version: integer("version").notNull(),
  active: boolean("active").notNull().default(true),
  uploadedBy: uuid("uploaded_by")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const runs = pgTable("runs", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => users.id),
  epicText: text("epic_text").notNull(),
  existingEpicKey: text("existing_epic_key"),
  status: text("status")
    .$type<"inputs" | "checked" | "questions" | "review" | "creating" | "done">()
    .notNull()
    .default("inputs"),
  fileVersions: jsonb("file_versions").$type<FileVersion[]>().notNull().default([]),
  structure: jsonb("structure"),
  roster: jsonb("roster"),
  assignableUsers: jsonb("assignable_users").$type<AssignableUser[]>(),
  clarificationsWritten: boolean("clarifications_written").notNull().default(false),
  /** Set while a ticket creation holds the run. A stale value (older than the lock timeout) no longer counts. */
  creatingSince: timestamp("creating_since", { withTimezone: true }),
  /** When the last creation attempt ended. Retries wait a few seconds after it, so Jira's search can index the issues. */
  lastCreateFinishedAt: timestamp("last_create_finished_at", { withTimezone: true }),
  /** Bumped on every draft write. Edits must present the version they were made from. */
  draftVersion: integer("draft_version").notNull().default(0),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const runDocuments = pgTable("run_documents", {
  id: id(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  kind: text("kind").notNull(),
  /** Parsed sections; null once the retention purge has removed them. */
  sections: jsonb("sections"),
  charCount: integer("char_count").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export const clarifyingQuestions = pgTable("clarifying_questions", {
  id: id(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  text: text("text").notNull(),
  sourceRefs: jsonb("source_refs").notNull(),
  rank: integer("rank").notNull(),
  resolution: jsonb("resolution"),
});

export const draftItems = pgTable("draft_items", {
  /** Set by the application, not defaulted by the database. */
  id: uuid("id").primaryKey(),
  runId: uuid("run_id")
    .notNull()
    .references(() => runs.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => draftItems.id, {
    onDelete: "cascade",
  }),
  position: integer("position").notNull(),
  kind: text("kind").$type<"epic" | "story" | "task">().notNull(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  acceptanceCriteria: jsonb("acceptance_criteria").$type<string[]>().notNull(),
  estimate: real("estimate"),
  sourceRefs: jsonb("source_refs").notNull(),
  origin: text("origin").notNull(),
  assumption: boolean("assumption").notNull().default(false),
  shapedBy: jsonb("shaped_by").notNull(),
  suggestionStatus: text("suggestion_status"),
  routing: jsonb("routing"),
  fieldValues: jsonb("field_values")
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  jiraKey: text("jira_key"),
  createError: text("create_error"),
});
