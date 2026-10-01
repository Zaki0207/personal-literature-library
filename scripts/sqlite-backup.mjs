import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { backup as sqliteBackup, DatabaseSync } from "node:sqlite";

function isoFileTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function backupStatusMessage(error) {
  const detail =
    error instanceof Error && error.message
      ? error.message
      : "未知文件系统错误";
  return `本地修改已保存，但 iCloud 备份失败：${detail}`;
}

export async function verifySqliteDatabaseFile(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const results = database.prepare("PRAGMA integrity_check").all();
    if (
      results.length !== 1 ||
      String(results[0].integrity_check).toLocaleLowerCase("en") !== "ok"
    ) {
      throw new Error(
        `SQLite 完整性检查失败：${results
          .map((result) => result.integrity_check)
          .join("；")}`,
      );
    }
  } finally {
    database.close();
  }
}

export async function readSqliteBackupStatus(backupDir) {
  try {
    const latestPath = join(backupDir, "library-latest.sqlite3");
    const latest = await stat(latestPath);
    await verifySqliteDatabaseFile(latestPath);
    return {
      ok: true,
      lastBackupAt: latest.mtime.toISOString(),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true };
    return {
      ok: false,
      message: `无法读取 iCloud 备份状态：${error.message}`,
    };
  }
}

async function uniqueVersionPath(backupDir, date) {
  const base = `library-${isoFileTimestamp(date)}`;
  for (let suffix = 0; suffix < 10_000; suffix += 1) {
    const candidate = join(
      backupDir,
      `${base}${suffix ? `-${suffix}` : ""}.sqlite3`,
    );
    try {
      await access(candidate);
    } catch (error) {
      if (error?.code === "ENOENT") return candidate;
      throw error;
    }
  }
  throw new Error("无法为备份生成唯一文件名。");
}

async function retainRecentBackups(backupDir, limit = 30) {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const versions = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^library-\d{4}-\d{2}-\d{2}T.*\.sqlite3$/.test(entry.name),
    )
    .map((entry) => entry.name)
    .sort()
    .reverse();
  await Promise.all(
    versions
      .slice(limit)
      .map((name) => rm(join(backupDir, name), { force: true })),
  );
}

export async function createSqliteBackup({
  db,
  backupDir,
  date,
  previousStatus = { ok: true },
}) {
  const token = `${process.pid}-${randomUUID()}`;
  const sqliteTemporaryPath = join(
    backupDir,
    `.library-${token}.tmp.sqlite3`,
  );
  const latestTemporaryPath = join(
    backupDir,
    `.library-latest-${token}.tmp.sqlite3`,
  );

  try {
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const versionPath = await uniqueVersionPath(backupDir, date);
    await sqliteBackup(db, sqliteTemporaryPath);
    await verifySqliteDatabaseFile(sqliteTemporaryPath);
    await rename(sqliteTemporaryPath, versionPath);
    await copyFile(versionPath, latestTemporaryPath);
    await verifySqliteDatabaseFile(latestTemporaryPath);
    await rename(latestTemporaryPath, join(backupDir, "library-latest.sqlite3"));

    let cleanupMessage;
    try {
      await retainRecentBackups(backupDir, 30);
    } catch (error) {
      cleanupMessage = `备份已完成，但旧版本清理失败：${error.message}`;
    }

    return {
      ok: true,
      lastBackupAt: date.toISOString(),
      ...(cleanupMessage ? { message: cleanupMessage } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      ...(previousStatus.lastBackupAt
        ? { lastBackupAt: previousStatus.lastBackupAt }
        : {}),
      message: backupStatusMessage(error),
    };
  } finally {
    await Promise.all([
      rm(sqliteTemporaryPath, { force: true }).catch(() => undefined),
      rm(latestTemporaryPath, { force: true }).catch(() => undefined),
    ]);
  }
}
