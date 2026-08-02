import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createLibraryRepository } from "../scripts/library-repository.mjs";

test("旧关键词列只迁移一次，并从数据库、接口模型和写入契约中移除", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "paper-keyword-migration-"));
  const dbPath = join(directory, "library.sqlite3");
  const backupDir = join(directory, "backups");
  t.after(() => rm(directory, { recursive: true, force: true }));

  let repository = await createLibraryRepository({
    dbPath,
    backupDir,
    seedPath: null,
  });
  await repository.createPaper({ title: "Existing Paper" });
  await repository.saveAiServiceModel({
    connectionId: "test-service",
    name: "Test Service",
    baseUrl: "https://ai.example/v1",
    model: "test-model",
    resolvedModel: "test-model",
    makeActive: true,
  });
  await repository.close();

  const legacy = new DatabaseSync(dbPath);
  legacy.exec(
    "ALTER TABLE papers ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'",
  );
  legacy.exec(
    `UPDATE papers
     SET source = '2025 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)',
         publication_date = '2025-06-12'
     WHERE title = 'Existing Paper'`,
  );
  legacy
    .prepare("DELETE FROM repository_migrations WHERE id = ?")
    .run("normalize-paper-publication-sources-v1");
  legacy.close();

  repository = await createLibraryRepository({
    dbPath,
    backupDir,
    seedPath: null,
  });
  t.after(() => repository.close());

  const columns = repository.db.prepare("PRAGMA table_info(papers)").all();
  assert.equal(columns.some((column) => column.name === "keywords_json"), false);
  assert.equal(
    Number(
      repository.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM repository_migrations
           WHERE id = 'remove-paper-keywords-v1'`,
        )
        .get().count,
    ),
    1,
  );
  assert.equal(repository.getLibrary().papers.length, 1);
  assert.equal(repository.getLibrary().papers[0].source, "CVPR 2025");
  assert.equal(repository.getAiServices().length, 1);
  assert.equal(repository.getAiServices()[0].models.length, 1);

  const created = await repository.createPaper({
    title: "No Keyword Paper",
    source:
      "2026 IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)",
    date: "2026-06",
  });
  assert.equal(Object.hasOwn(created.paper, "keywords"), false);
  assert.equal(created.paper.source, "CVPR 2026");
  const updated = await repository.updatePaper(created.paper.id, {
    source: "CVPR 2026（Oral）",
  });
  assert.equal(updated.paper.source, "CVPR 2026 (Oral)");
  await assert.rejects(
    repository.createPaper({
      title: "Legacy Input",
      keywords: ["legacy"],
    }),
    (error) =>
      error?.code === "VALIDATION_ERROR" && /不支持的字段/u.test(error.message),
  );

  await repository.close();
  repository = await createLibraryRepository({
    dbPath,
    backupDir,
    seedPath: null,
  });
  assert.equal(
    Number(
      repository.db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM repository_migrations
           WHERE id = 'remove-paper-keywords-v1'`,
        )
        .get().count,
    ),
    1,
  );
});
