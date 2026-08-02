#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const SEED_PATH = join(PROJECT_DIRECTORY, "local-data", "library-data.json");
const DATABASE_PATH = join(
  homedir(),
  "Library",
  "Application Support",
  "个人文献库",
  "library.sqlite3",
);
const BACKUP_DIRECTORY = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "个人文献库备份",
);

function fileTimestamp(date = new Date()) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function verifyDatabase(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0].integrity_check !== "ok") {
      throw new Error("SQLite 完整性检查失败");
    }
  } finally {
    database.close();
  }
}

async function clearSeedNotes() {
  const seed = JSON.parse(await readFile(SEED_PATH, "utf8"));
  let changed = 0;
  seed.papers = seed.papers.map((paper) => {
    if (String(paper.note ?? "").trim() || Number(paper.noteCount ?? 0)) {
      changed += 1;
    }
    return { ...paper, note: "", noteCount: 0 };
  });

  const temporaryPath = `${SEED_PATH}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(seed, null, 2)}\n`, "utf8");
  await rename(temporaryPath, SEED_PATH);
  return changed;
}

async function clearDatabaseNotes() {
  await mkdir(BACKUP_DIRECTORY, { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(DATABASE_PATH);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  const timestamp = fileTimestamp();
  const beforePath = join(
    BACKUP_DIRECTORY,
    `library-before-clearing-notes-${timestamp}.sqlite3`,
  );
  await sqliteBackup(database, beforePath);
  verifyDatabase(beforePath);

  const updatedAt = new Date().toISOString();
  database.exec("BEGIN IMMEDIATE");
  let changed;
  try {
    changed = database
      .prepare(
        `UPDATE papers
         SET note = '', note_count = 0, updated_at = ?
         WHERE deleted_at IS NULL
           AND (trim(note) <> '' OR coalesce(note_count, 0) <> 0)`,
      )
      .run(updatedAt).changes;
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    throw error;
  }

  const remaining = database
    .prepare(
      `SELECT count(*) AS count
       FROM papers
       WHERE deleted_at IS NULL
         AND (trim(note) <> '' OR coalesce(note_count, 0) <> 0)`,
    )
    .get().count;
  if (remaining !== 0) {
    database.close();
    throw new Error(`仍有 ${remaining} 条笔记未清空`);
  }

  const integrity = database.prepare("PRAGMA integrity_check").get();
  if (integrity.integrity_check !== "ok") {
    database.close();
    throw new Error("更新后的 SQLite 未通过完整性检查");
  }

  const token = `${process.pid}-${randomUUID()}`;
  const versionTemp = join(BACKUP_DIRECTORY, `.library-${token}.tmp.sqlite3`);
  const latestTemp = join(
    BACKUP_DIRECTORY,
    `.library-latest-${token}.tmp.sqlite3`,
  );
  const versionPath = join(BACKUP_DIRECTORY, `library-${timestamp}.sqlite3`);
  const latestPath = join(BACKUP_DIRECTORY, "library-latest.sqlite3");

  await sqliteBackup(database, versionTemp);
  verifyDatabase(versionTemp);
  await rename(versionTemp, versionPath);
  await copyFile(versionPath, latestTemp);
  verifyDatabase(latestTemp);
  await rename(latestTemp, latestPath);
  database.close();

  return { beforePath, changed, latestPath, versionPath };
}

const seedChanged = await clearSeedNotes();
const databaseResult = await clearDatabaseNotes();
console.log(JSON.stringify({ seedChanged, ...databaseResult }, null, 2));
