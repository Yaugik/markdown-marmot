import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import * as schema from "./schema";

const globalDb = globalThis as unknown as { sqlite?: Database.Database };

export function sqlite(): Database.Database {
  if (!globalDb.sqlite) {
    fs.mkdirSync(path.dirname(path.resolve(env.DATABASE_PATH)), { recursive: true });
    globalDb.sqlite = new Database(env.DATABASE_PATH);
    globalDb.sqlite.pragma("journal_mode = WAL");
    globalDb.sqlite.pragma("foreign_keys = ON");
    globalDb.sqlite.pragma("busy_timeout = 5000");
  }
  return globalDb.sqlite;
}

export function db() {
  return drizzle(sqlite(), { schema });
}
