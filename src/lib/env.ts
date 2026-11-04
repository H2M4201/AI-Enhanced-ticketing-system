import { z } from "zod";

const schema = z.preprocess(
  (raw) => {
    // Treat blank lines such as "DATABASE_URL=" in .env as unset.
    const input = (raw ?? {}) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, v === "" ? undefined : v]),
    );
  },
  z.object({
    ATLASSIAN_CLIENT_ID: z.string().min(1),
    ATLASSIAN_CLIENT_SECRET: z.string().min(1),
    APP_URL: z.string().url().default("http://localhost:3000"),
    SESSION_SECRET: z.string().min(32),
    ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, {
        message: "must be base64 encoding of 32 bytes",
      }),
    DATABASE_URL: z.string().optional(),
    LLM_BASE_URL: z.string().optional(),
    LLM_API_KEY: z.string().optional(),
    LLM_MODEL: z.string().optional(),
    LLM_CONTEXT_TOKENS: z.coerce.number().int().positive().default(128000),
    RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  }),
);

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/**
 * Returns validated environment configuration. Parsed lazily and cached.
 * Error messages name the invalid variables but never include their values.
 */
export function getEnv(): Env {
  if (cached) return cached;
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const names = [...new Set(result.error.issues.map((i) => String(i.path[0] ?? "unknown")))];
    throw new Error(`Invalid environment configuration: ${names.join(", ")}`);
  }
  cached = result.data;
  return cached;
}

/** Clears the cached configuration. Intended for tests. */
export function resetEnvCache(): void {
  cached = undefined;
}
