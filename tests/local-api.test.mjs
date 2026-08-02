import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createLibraryApi } from "../scripts/library-api.mjs";

const TEST_CATEGORY_RECORDS = [
  { id: "F6YQU7CN", name: "3DV", parentId: null },
  { id: "XS7TTTNN", name: "流体重建", parentId: "F6YQU7CN" },
  { id: "PVW7AF4Y", name: "Gaussian Splatting", parentId: "XS7TTTNN" },
  { id: "WERT8GBF", name: "表面重建", parentId: "F6YQU7CN" },
  { id: "HMWLPLJA", name: "静态重建", parentId: "F6YQU7CN" },
  { id: "TSTCAT01", name: "动态重建", parentId: "F6YQU7CN" },
  { id: "TSTCAT02", name: "物理仿真", parentId: "F6YQU7CN" },
  { id: "TSTCAT03", name: "数据集", parentId: "F6YQU7CN" },
  { id: "TSTCAT04", name: "阅读笔记", parentId: "F6YQU7CN" },
].map((category, sortOrder) => ({
  ...category,
  sourceKind: "test",
  sourceKey: category.id,
  sourceParentId: category.parentId,
  sortOrder,
  sidebarVisible: true,
}));

function createTestSeed() {
  const specialPapers = [
    {
      id: "MQ2JQEDV",
      title: "Synthetic Gaussian Paper",
      categoryIds: ["PVW7AF4Y"],
    },
    {
      id: "I7JCXVU8",
      title: "Synthetic Watch Later Paper A",
      categoryIds: ["PVW7AF4Y", "WERT8GBF"],
      watchLater: true,
    },
    {
      id: "P78ZAPPU",
      title: "Synthetic Watch Later Paper B",
      categoryIds: ["HMWLPLJA"],
      watchLater: true,
    },
  ];
  const generatedPapers = Array.from({ length: 27 }, (_, index) => ({
    id: `TEST${String(index + 1).padStart(4, "0")}`,
    title: `Synthetic Test Paper ${index + 1}`,
    categoryIds:
      index % 3 === 0 ? ["F6YQU7CN"] : index % 3 === 1 ? ["TSTCAT01"] : [],
  }));

  return {
    categoryRecords: TEST_CATEGORY_RECORDS,
    papers: [...specialPapers, ...generatedPapers].map((paper, index) => ({
      zhTitle: `测试论文 ${index + 1}`,
      authors: "测试作者",
      institution: "测试机构",
      source: "测试来源",
      date: "2026-01-01",
      dateAdded: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      aiSummary: "仅用于自动化测试的合成数据。",
      note: "",
      favorite: false,
      watchLater: false,
      hasPdf: false,
      ...paper,
    })),
  };
}

async function makeFixture(t, name) {
  const directory = await mkdtemp(join(tmpdir(), `library-api-${name}-`));
  const dbPath = join(directory, "database", "library.sqlite3");
  const backupDir = join(directory, "icloud-backups");
  const seedPath = join(directory, "library-seed.json");
  await writeFile(seedPath, JSON.stringify(createTestSeed()), "utf8");
  let api;

  const start = async () => {
    api = await createLibraryApi({
      port: 0,
      dbPath,
      backupDir,
      seedPath,
    });
    const address = await api.listen();
    return { api, baseUrl: address.url };
  };

  const close = async () => {
    if (!api) return;
    await api.close();
    api = undefined;
  };

  t.after(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });

  return { directory, dbPath, backupDir, seedPath, start, close };
}

async function jsonRequest(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

function versionFiles(entries) {
  return entries.filter(
    (name) =>
      name !== "library-latest.sqlite3" &&
      /^library-\d{4}-\d{2}-\d{2}T.*\.sqlite3$/.test(name),
  );
}

function findCategoryInTree(categories, id) {
  for (const category of categories) {
    if (category.id === id) return category;
    const nested = findCategoryInTree(category.children ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}

test("首次启动保留待看标记并返回递归三级分类树", async (t) => {
  const fixture = await makeFixture(t, "seed");
  const { api, baseUrl } = await fixture.start();

  const { response, body } = await jsonRequest(baseUrl, "/api/library");
  assert.equal(response.status, 200);
  assert.equal(body.papers.length, 30);
  assert.equal(body.categories.length, 1);
  assert.equal(body.backup.ok, true);
  assert.ok(body.backup.lastBackupAt);
  assert.ok(
    (await readdir(fixture.backupDir)).includes("library-latest.sqlite3"),
  );

  const gaussian = body.papers.find(
    (paper) =>
      paper.categoryIds.length === 1 &&
      paper.categoryIds[0] === "PVW7AF4Y",
  );
  assert.ok(gaussian, "应保留直接 Zotero 分类 ID");
  assert.deepEqual(
    gaussian.tags.map((tag) => tag.scope),
    ["PVW7AF4Y"],
  );
  assert.deepEqual(gaussian.scopes, [
    "PVW7AF4Y",
    "XS7TTTNN",
    "F6YQU7CN",
  ]);

  const root3dv = body.categories.find(
    (category) => category.id === "F6YQU7CN",
  );
  const fluidReconstruction = root3dv.children.find(
    (category) => category.id === "XS7TTTNN",
  );
  const projectedGaussian = fluidReconstruction.children.find(
    (category) => category.id === "PVW7AF4Y",
  );
  assert.equal(projectedGaussian.name, "Gaussian Splatting");
  assert.equal(root3dv.sidebarVisible, true);
  assert.equal(fluidReconstruction.sidebarVisible, true);
  assert.equal(projectedGaussian.sidebarVisible, true);
  assert.deepEqual(projectedGaussian.ancestorIds, [
    "XS7TTTNN",
    "F6YQU7CN",
  ]);
  assert.deepEqual(fluidReconstruction.ancestorIds, ["F6YQU7CN"]);
  assert.deepEqual(root3dv.ancestorIds, []);

  assert.deepEqual(
    body.papers
      .filter((paper) => paper.watchLater)
      .map((paper) => paper.id)
      .sort(),
    ["I7JCXVU8", "P78ZAPPU"],
    "只保留原“待看”集合中的论文标记",
  );
  assert.equal(
    body.papers
      .filter((paper) => !["I7JCXVU8", "P78ZAPPU"].includes(paper.id))
      .every((paper) => paper.watchLater === false),
    true,
  );
  assert.equal(
    body.papers.every((paper) => !Object.hasOwn(paper, "status")),
    true,
    "阅读状态不再出现在 API 响应中",
  );
  assert.equal(
    body.papers.every(
      (paper) => !paper.categoryIds.includes("BGPSP4JY"),
    ),
    true,
  );

  const categoryResponse = await jsonRequest(baseUrl, "/api/categories");
  assert.equal(
    categoryResponse.body.categories.every(
      (category) => category.sidebarVisible === true,
    ),
    true,
  );
  assert.equal(
    categoryResponse.body.categories.some(
      (category) => category.id === "BGPSP4JY",
    ),
    false,
  );
  assert.equal(
    categoryResponse.body.deletedCategories.some(
      (category) => category.id === "BGPSP4JY",
    ),
    false,
    "旧待看分类不进入最近删除",
  );

  const database = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    assert.equal(
      Number(
        database.prepare("SELECT COUNT(*) AS count FROM papers").get().count,
      ),
      30,
    );
    assert.equal(
      Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM categories")
          .get().count,
      ),
      9,
    );
    assert.equal(
      Number(
        database
          .prepare("SELECT COUNT(*) AS count FROM paper_categories")
          .get().count,
      ),
      body.papers.reduce(
        (total, paper) => total + paper.categoryIds.length,
        0,
      ),
    );
    assert.equal(
      database
        .prepare("PRAGMA table_info(papers)")
        .all()
        .some((column) => column.name === "watch_later"),
      true,
    );
    const migration = database
      .prepare(
        `SELECT details_json AS detailsJson
         FROM repository_migrations
         WHERE id = 'legacy-watch-later-category-v1'`,
      )
      .get();
    assert.ok(migration);
    assert.deepEqual(
      JSON.parse(migration.detailsJson).migratedPaperIds.sort(),
      [],
      "新格式种子不需要再次执行旧分类转换",
    );
    assert.equal(
      database.prepare("PRAGMA journal_mode").get().journal_mode,
      "delete",
    );
    assert.equal(
      Number(database.prepare("PRAGMA synchronous").get().synchronous),
      2,
    );
  } finally {
    database.close();
  }
  assert.equal(
    Number(api.repository.db.prepare("PRAGMA busy_timeout").get().timeout),
    5_000,
  );
});

test("PATCH 持久化 watchLater，旧 status 输入和非法 URL 不会写入", async (t) => {
  const fixture = await makeFixture(t, "patch");
  let running = await fixture.start();
  const paperId = "MQ2JQEDV";

  const update = await jsonRequest(
    running.baseUrl,
    `/api/papers/${paperId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        title: "本地持久化标题",
        watchLater: true,
        aiSummary: "这条总结由本地编辑器保存。",
        codeUrl: "https://github.com/example/persistent-paper",
        categoryIds: ["PVW7AF4Y"],
      }),
    },
  );
  assert.equal(update.response.status, 200);
  assert.equal(update.body.paper.title, "本地持久化标题");
  assert.equal(update.body.paper.watchLater, true);
  assert.equal(Object.hasOwn(update.body.paper, "status"), false);
  assert.equal(update.body.backup.ok, true);
  assert.ok(update.body.backup.lastBackupAt);
  assert.deepEqual(update.body.paper.scopes, [
    "PVW7AF4Y",
    "XS7TTTNN",
    "F6YQU7CN",
  ]);

  const backupEntriesBeforeInvalid = await readdir(fixture.backupDir);
  assert.ok(backupEntriesBeforeInvalid.includes("library-latest.sqlite3"));
  assert.equal(versionFiles(backupEntriesBeforeInvalid).length, 2);

  const retiredStatus = await jsonRequest(
    running.baseUrl,
    `/api/papers/${paperId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        title: "不应保存的标题",
        status: "在读",
      }),
    },
  );
  assert.equal(retiredStatus.response.status, 400);
  assert.equal(retiredStatus.body.error.code, "VALIDATION_ERROR");
  assert.deepEqual(retiredStatus.body.error.details.fields, ["status"]);

  const invalidWatchLater = await jsonRequest(
    running.baseUrl,
    `/api/papers/${paperId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ watchLater: "yes" }),
    },
  );
  assert.equal(invalidWatchLater.response.status, 400);
  assert.equal(
    invalidWatchLater.body.error.details.field,
    "watchLater",
  );

  const invalidUrl = await jsonRequest(
    running.baseUrl,
    `/api/papers/${paperId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ codeUrl: "javascript:alert(1)" }),
    },
  );
  assert.equal(invalidUrl.response.status, 400);
  assert.equal(invalidUrl.body.error.details.field, "codeUrl");

  const afterInvalid = await jsonRequest(running.baseUrl, "/api/library");
  const unchanged = afterInvalid.body.papers.find(
    (paper) => paper.id === paperId,
  );
  assert.equal(unchanged.title, "本地持久化标题");
  assert.equal(unchanged.watchLater, true);
  assert.equal(Object.hasOwn(unchanged, "status"), false);
  assert.equal(
    versionFiles(await readdir(fixture.backupDir)).length,
    2,
    "校验失败不应创建备份",
  );

  await fixture.close();
  running = await fixture.start();
  const afterRestart = await jsonRequest(running.baseUrl, "/api/library");
  const persisted = afterRestart.body.papers.find(
    (paper) => paper.id === paperId,
  );
  assert.equal(persisted.title, "本地持久化标题");
  assert.equal(persisted.watchLater, true);
  assert.equal(Object.hasOwn(persisted, "status"), false);
  assert.equal(persisted.aiSummary, "这条总结由本地编辑器保存。");
  assert.equal(
    persisted.codeUrl,
    "https://github.com/example/persistent-paper",
  );
  assert.ok(afterRestart.body.backup.lastBackupAt);
});

test("删除为可恢复的软删除，主库和最新备份都通过完整性检查", async (t) => {
  const fixture = await makeFixture(t, "restore");
  const { baseUrl } = await fixture.start();
  const paperId = "MQ2JQEDV";

  const deleted = await jsonRequest(
    baseUrl,
    `/api/papers/${paperId}`,
    { method: "DELETE" },
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.paper.id, paperId);
  assert.ok(deleted.body.paper.deletedAt);
  assert.equal(deleted.body.backup.ok, true);

  const withoutDeleted = await jsonRequest(baseUrl, "/api/library");
  assert.equal(withoutDeleted.body.papers.length, 29);
  assert.equal(
    withoutDeleted.body.papers.some((paper) => paper.id === paperId),
    false,
  );

  const restored = await jsonRequest(
    baseUrl,
    `/api/papers/${paperId}/restore`,
    { method: "POST" },
  );
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.paper.id, paperId);
  assert.equal(restored.body.paper.deletedAt, undefined);
  assert.equal(restored.body.backup.ok, true);

  const afterRestore = await jsonRequest(baseUrl, "/api/library");
  assert.equal(afterRestore.body.papers.length, 30);

  const health = await jsonRequest(baseUrl, "/api/health");
  assert.equal(health.response.status, 200);
  assert.deepEqual(health.body.integrity, ["ok"]);

  await fixture.close();
  for (const path of [
    fixture.dbPath,
    join(fixture.backupDir, "library-latest.sqlite3"),
  ]) {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        database
          .prepare("PRAGMA integrity_check")
          .all()
          .map((row) => row.integrity_check),
        ["ok"],
      );
    } finally {
      database.close();
    }
  }
});

test("POST 论文与分类使用相同响应契约", async (t) => {
  const fixture = await makeFixture(t, "create");
  const { baseUrl } = await fixture.start();

  const categoryResponse = await jsonRequest(
    baseUrl,
    "/api/categories",
    {
      method: "POST",
      body: JSON.stringify({ name: "本地实验分类", parentId: "F6YQU7CN" }),
    },
  );
  assert.equal(categoryResponse.response.status, 201);
  assert.equal(categoryResponse.body.category.name, "本地实验分类");
  assert.equal(categoryResponse.body.category.sidebarVisible, true);
  assert.equal(categoryResponse.body.backup.ok, true);

  const categoryId = categoryResponse.body.category.id;
  const paperResponse = await jsonRequest(baseUrl, "/api/papers", {
    method: "POST",
    body: JSON.stringify({
      title: "A Locally Authored Paper",
      zhTitle: "一篇本地新增论文",
      authors: "本地作者",
      favorite: false,
      watchLater: true,
      hasPdf: false,
      categoryIds: [categoryId],
    }),
  });
  assert.equal(paperResponse.response.status, 201);
  assert.equal(paperResponse.body.paper.title, "A Locally Authored Paper");
  assert.equal(paperResponse.body.paper.watchLater, true);
  assert.equal(Object.hasOwn(paperResponse.body.paper, "status"), false);
  assert.deepEqual(paperResponse.body.paper.categoryIds, [categoryId]);
  assert.deepEqual(paperResponse.body.paper.scopes, [
    categoryId,
    "F6YQU7CN",
  ]);
  assert.equal(paperResponse.body.backup.ok, true);
});

test("分类 API 返回规范记录，并支持重命名和受约束的层级移动", async (t) => {
  const fixture = await makeFixture(t, "category-edit");
  const { baseUrl } = await fixture.start();

  const initial = await jsonRequest(baseUrl, "/api/categories");
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.categories.length, 9);
  assert.deepEqual(initial.body.deletedCategories, []);
  assert.equal(
    initial.body.categories.some(
      (category) => category.id === "BGPSP4JY",
    ),
    false,
  );
  const gaussianBefore = initial.body.categories.find(
    (category) => category.id === "PVW7AF4Y",
  );
  assert.deepEqual(gaussianBefore.ancestorIds, [
    "XS7TTTNN",
    "F6YQU7CN",
  ]);
  assert.equal(typeof gaussianBefore.directCount, "number");
  assert.equal(typeof gaussianBefore.totalCount, "number");
  assert.equal(gaussianBefore.parentId, "XS7TTTNN");

  const renamed = await jsonRequest(
    baseUrl,
    "/api/categories/PVW7AF4Y",
    {
      method: "PATCH",
      body: JSON.stringify({ name: "高斯泼溅" }),
    },
  );
  assert.equal(renamed.response.status, 200);
  assert.equal(renamed.body.category.id, "PVW7AF4Y");
  assert.equal(renamed.body.category.name, "高斯泼溅");
  assert.equal(
    renamed.body.library.papers.find((paper) =>
      paper.categoryIds.includes("PVW7AF4Y"),
    ).tags.find((tag) => tag.scope === "PVW7AF4Y").label,
    "高斯泼溅",
  );
  assert.equal(renamed.body.backup.ok, true);

  const destinationRoot = await jsonRequest(baseUrl, "/api/categories", {
    method: "POST",
    body: JSON.stringify({ name: "移动目标", parentId: null }),
  });
  assert.equal(destinationRoot.response.status, 201);
  assert.equal(destinationRoot.body.category.sidebarVisible, true);
  const destinationRootId = destinationRoot.body.category.id;

  const legacyParentMoved = await jsonRequest(
    baseUrl,
    "/api/categories/XS7TTTNN",
    {
      method: "PATCH",
      body: JSON.stringify({ parentId: destinationRootId }),
    },
  );
  assert.equal(legacyParentMoved.response.status, 200);
  assert.deepEqual(legacyParentMoved.body.category.ancestorIds, [
    destinationRootId,
  ]);
  assert.deepEqual(
    (
      await jsonRequest(baseUrl, "/api/categories")
    ).body.categories.find((category) => category.id === "PVW7AF4Y")
      .ancestorIds,
    ["XS7TTTNN", destinationRootId],
    "移动分类时应连同整个子树保持合法的三级结构",
  );

  const moved = await jsonRequest(
    baseUrl,
    "/api/categories/PVW7AF4Y",
    {
      method: "PATCH",
      body: JSON.stringify({ parentId: destinationRootId }),
    },
  );
  assert.equal(moved.response.status, 200);
  assert.equal(moved.body.category.id, "PVW7AF4Y");
  assert.equal(moved.body.category.parentId, destinationRootId);
  assert.deepEqual(moved.body.category.ancestorIds, [destinationRootId]);
  const movedPaper = moved.body.library.papers.find((paper) =>
    paper.categoryIds.includes("PVW7AF4Y"),
  );
  assert.equal(movedPaper.scopes.includes("PVW7AF4Y"), true);
  assert.equal(movedPaper.scopes.includes(destinationRootId), true);

  const movedToThirdLevel = await jsonRequest(
    baseUrl,
    "/api/categories/PVW7AF4Y",
    {
      method: "PATCH",
      body: JSON.stringify({ parentId: "WERT8GBF" }),
    },
  );
  assert.equal(movedToThirdLevel.response.status, 200);
  assert.deepEqual(movedToThirdLevel.body.category.ancestorIds, [
    "WERT8GBF",
    "F6YQU7CN",
  ]);

  const duplicate = await jsonRequest(
    baseUrl,
    "/api/categories/HMWLPLJA",
    {
      method: "PATCH",
      body: JSON.stringify({ name: "表面重建" }),
    },
  );
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, "CONFLICT");

  const createdThirdLevel = await jsonRequest(
    baseUrl,
    "/api/categories",
    {
      method: "POST",
      body: JSON.stringify({
        name: "第三级分类",
        parentId: "WERT8GBF",
      }),
    },
  );
  assert.equal(createdThirdLevel.response.status, 201);
  assert.deepEqual(createdThirdLevel.body.category.ancestorIds, [
    "WERT8GBF",
    "F6YQU7CN",
  ]);
  const thirdLevelId = createdThirdLevel.body.category.id;
  const libraryAfterThird = await jsonRequest(baseUrl, "/api/library");
  assert.equal(
    findCategoryInTree(
      libraryAfterThird.body.categories,
      thirdLevelId,
    )?.name,
    "第三级分类",
  );

  const createTooDeep = await jsonRequest(baseUrl, "/api/categories", {
    method: "POST",
    body: JSON.stringify({
      name: "不允许的第四级",
      parentId: thirdLevelId,
    }),
  });
  assert.equal(createTooDeep.response.status, 400);
  assert.match(createTooDeep.body.error.message, /最多支持3级/);

  const moveParentDown = await jsonRequest(
    baseUrl,
    "/api/categories/F6YQU7CN",
    {
      method: "PATCH",
      body: JSON.stringify({ parentId: destinationRootId }),
    },
  );
  assert.equal(moveParentDown.response.status, 400);
  assert.match(moveParentDown.body.error.message, /3级/);
  assert.equal(moveParentDown.body.error.details.resultingDepth, 4);

  const cycle = await jsonRequest(
    baseUrl,
    `/api/categories/${destinationRootId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ parentId: "XS7TTTNN" }),
    },
  );
  assert.equal(cycle.response.status, 400);
  assert.match(cycle.body.error.message, /后代/);
});

test("分类 API 可持久化同级分类的自定义顺序", async (t) => {
  const fixture = await makeFixture(t, "category-reorder");
  const { baseUrl } = await fixture.start();

  const initial = await jsonRequest(baseUrl, "/api/categories");
  const rootIds = initial.body.categories
    .filter((category) => category.parentId === null)
    .map((category) => category.id);
  const reorderedRootIds = [...rootIds].reverse();

  const reorderedRoots = await jsonRequest(
    baseUrl,
    "/api/categories/reorder",
    {
      method: "PUT",
      body: JSON.stringify({ parentId: null, orderedIds: reorderedRootIds }),
    },
  );
  assert.equal(reorderedRoots.response.status, 200);
  assert.deepEqual(
    reorderedRoots.body.categories
      .filter((category) => category.parentId === null)
      .map((category) => category.id),
    reorderedRootIds,
  );
  assert.equal(reorderedRoots.body.backup.ok, true);

  const initialChildren = reorderedRoots.body.categories
    .filter((category) => category.parentId === "F6YQU7CN")
    .map((category) => category.id);
  const reorderedChildren = [
    ...initialChildren.slice(1),
    initialChildren[0],
  ];
  const reorderedChildResponse = await jsonRequest(
    baseUrl,
    "/api/categories/reorder",
    {
      method: "PUT",
      body: JSON.stringify({
        parentId: "F6YQU7CN",
        orderedIds: reorderedChildren,
      }),
    },
  );
  assert.equal(reorderedChildResponse.response.status, 200);
  assert.deepEqual(
    reorderedChildResponse.body.categories
      .filter((category) => category.parentId === "F6YQU7CN")
      .map((category) => category.id),
    reorderedChildren,
  );

  const invalid = await jsonRequest(baseUrl, "/api/categories/reorder", {
    method: "PUT",
    body: JSON.stringify({
      parentId: "F6YQU7CN",
      orderedIds: ["WERT8GBF"],
    }),
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
});

test("一级分类侧栏显示开关持久化，且不改变分类数据", async (t) => {
  const fixture = await makeFixture(t, "category-sidebar-visible");
  let running = await fixture.start();

  const before = await jsonRequest(running.baseUrl, "/api/library");
  const rootBefore = findCategoryInTree(
    before.body.categories,
    "F6YQU7CN",
  );
  const paperMembershipBefore = before.body.papers.map((paper) => ({
    id: paper.id,
    categoryIds: paper.categoryIds,
    scopes: paper.scopes,
  }));
  assert.equal(rootBefore.sidebarVisible, true);

  const hidden = await jsonRequest(
    running.baseUrl,
    "/api/categories/F6YQU7CN",
    {
      method: "PATCH",
      body: JSON.stringify({ sidebarVisible: false }),
    },
  );
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.body.category.sidebarVisible, false);
  const hiddenRoot = findCategoryInTree(
    hidden.body.library.categories,
    "F6YQU7CN",
  );
  assert.ok(hiddenRoot, "隐藏只影响前端展示，不应从 API 分类树删除");
  assert.equal(hiddenRoot.sidebarVisible, false);
  assert.equal(hiddenRoot.count, rootBefore.count);
  assert.deepEqual(
    hidden.body.library.papers.map((paper) => ({
      id: paper.id,
      categoryIds: paper.categoryIds,
      scopes: paper.scopes,
    })),
    paperMembershipBefore,
  );
  assert.equal(hidden.body.backup.ok, true);

  const childRejected = await jsonRequest(
    running.baseUrl,
    "/api/categories/WERT8GBF",
    {
      method: "PATCH",
      body: JSON.stringify({ sidebarVisible: false }),
    },
  );
  assert.equal(childRejected.response.status, 400);
  assert.equal(
    childRejected.body.error.details.field,
    "sidebarVisible",
  );
  const afterChildRejection = await jsonRequest(
    running.baseUrl,
    "/api/categories",
  );
  assert.equal(
    afterChildRejection.body.categories.find(
      (category) => category.id === "WERT8GBF",
    ).sidebarVisible,
    true,
  );

  const movableRoot = await jsonRequest(
    running.baseUrl,
    "/api/categories",
    {
      method: "POST",
      body: JSON.stringify({
        name: "侧栏开关迁移测试",
        parentId: null,
        sidebarVisible: false,
      }),
    },
  );
  assert.equal(movableRoot.response.status, 201);
  assert.equal(movableRoot.body.category.sidebarVisible, false);
  const movableRootId = movableRoot.body.category.id;

  const explicitHiddenChildRejected = await jsonRequest(
    running.baseUrl,
    `/api/categories/${movableRootId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        parentId: "F6YQU7CN",
        sidebarVisible: false,
      }),
    },
  );
  assert.equal(explicitHiddenChildRejected.response.status, 400);
  assert.equal(
    explicitHiddenChildRejected.body.error.details.field,
    "sidebarVisible",
  );

  const movedToChild = await jsonRequest(
    running.baseUrl,
    `/api/categories/${movableRootId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ parentId: "F6YQU7CN" }),
    },
  );
  assert.equal(movedToChild.response.status, 200);
  assert.equal(movedToChild.body.category.parentId, "F6YQU7CN");
  assert.equal(movedToChild.body.category.sidebarVisible, true);

  const movedBackAndHidden = await jsonRequest(
    running.baseUrl,
    `/api/categories/${movableRootId}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        parentId: null,
        sidebarVisible: false,
      }),
    },
  );
  assert.equal(movedBackAndHidden.response.status, 200);
  assert.equal(movedBackAndHidden.body.category.parentId, null);
  assert.equal(movedBackAndHidden.body.category.sidebarVisible, false);

  await fixture.close();
  running = await fixture.start();
  const afterRestart = await jsonRequest(
    running.baseUrl,
    "/api/categories",
  );
  assert.equal(
    afterRestart.body.categories.find(
      (category) => category.id === "F6YQU7CN",
    ).sidebarVisible,
    false,
  );
  assert.equal(
    afterRestart.body.categories.find(
      (category) => category.id === movableRootId,
    ).sidebarVisible,
    false,
  );
  assert.equal(
    findCategoryInTree(
      (
        await jsonRequest(running.baseUrl, "/api/library")
      ).body.categories,
      "F6YQU7CN",
    ).sidebarVisible,
    false,
  );

  const database = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    assert.equal(
      Number(
        database
          .prepare(
            `SELECT sidebar_visible AS sidebarVisible
             FROM categories
             WHERE id = 'F6YQU7CN'`,
          )
          .get().sidebarVisible,
      ),
      0,
    );
  } finally {
    database.close();
  }
});

test("分类软删除保留论文关联、报告影响统计并可恢复", async (t) => {
  const fixture = await makeFixture(t, "category-delete");
  const { baseUrl } = await fixture.start();
  const categoryId = "PVW7AF4Y";

  const before = await jsonRequest(baseUrl, "/api/library");
  const linkedBefore = before.body.papers.filter((paper) =>
    paper.categoryIds.includes(categoryId),
  );
  const expectedUncategorized = linkedBefore.filter(
    (paper) => paper.categoryIds.length === 1,
  ).length;
  const relationCountBefore = linkedBefore.length;

  const nonLeaf = await jsonRequest(
    baseUrl,
    "/api/categories/XS7TTTNN",
    { method: "DELETE" },
  );
  assert.equal(nonLeaf.response.status, 409);
  assert.match(nonLeaf.body.error.message, /子分类/);

  const invalidPolicy = await jsonRequest(
    baseUrl,
    `/api/categories/${categoryId}`,
    {
      method: "DELETE",
      body: JSON.stringify({ paperPolicy: "delete-papers" }),
    },
  );
  assert.equal(invalidPolicy.response.status, 400);
  assert.equal(invalidPolicy.body.error.details.field, "paperPolicy");

  const deleted = await jsonRequest(
    baseUrl,
    `/api/categories/${categoryId}`,
    {
      method: "DELETE",
      body: JSON.stringify({ paperPolicy: "detach" }),
    },
  );
  assert.equal(deleted.response.status, 200);
  assert.equal(deleted.body.category.id, categoryId);
  assert.ok(deleted.body.category.deletedAt);
  assert.deepEqual(deleted.body.stats, {
    directPaperCount: linkedBefore.length,
    wouldBecomeUncategorizedCount: expectedUncategorized,
    retainingOtherCategoryCount: linkedBefore.length - expectedUncategorized,
  });
  assert.equal(
    findCategoryInTree(deleted.body.library.categories, categoryId),
    undefined,
  );
  for (const paper of linkedBefore) {
    const after = deleted.body.library.papers.find(
      (candidate) => candidate.id === paper.id,
    );
    assert.equal(after.categoryIds.includes(categoryId), false);
    if (paper.categoryIds.length === 1) {
      assert.deepEqual(after.scopes, ["uncategorized"]);
    }
  }

  const relationDatabase = new DatabaseSync(fixture.dbPath, {
    readOnly: true,
  });
  try {
    assert.equal(
      Number(
        relationDatabase
          .prepare(
            "SELECT COUNT(*) AS count FROM paper_categories WHERE category_id = ?",
          )
          .get(categoryId).count,
      ),
      relationCountBefore,
      "软删除必须保留 paper_categories",
    );
  } finally {
    relationDatabase.close();
  }

  const categoriesAfterDelete = await jsonRequest(
    baseUrl,
    "/api/categories",
  );
  assert.equal(
    categoriesAfterDelete.body.categories.some(
      (category) => category.id === categoryId,
    ),
    false,
  );
  assert.equal(
    categoriesAfterDelete.body.deletedCategories.some(
      (category) => category.id === categoryId,
    ),
    true,
  );
  const fluidRoot = categoriesAfterDelete.body.categories.find(
    (category) => category.id === "XS7TTTNN",
  );
  assert.equal(
    fluidRoot.totalCount,
    categoriesAfterDelete.body.categories.find(
      (category) => category.id === "XS7TTTNN",
    ).directCount,
    "活动父分类统计不应包含已删除子分类",
  );

  const paperPreservedWhileCategoryDeleted = deleted.body.library.papers.find(
    (paper) => paper.id === linkedBefore[0].id,
  );
  const noteOnlyEdit = await jsonRequest(
    baseUrl,
    `/api/papers/${paperPreservedWhileCategoryDeleted.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        note: "分类删除期间编辑的笔记",
      }),
    },
  );
  assert.equal(noteOnlyEdit.response.status, 200);

  const paperReclassifiedWhileCategoryDeleted =
    deleted.body.library.papers.find(
      (paper) => paper.id === linkedBefore[1].id,
    );
  const categoryEdit = await jsonRequest(
    baseUrl,
    `/api/papers/${paperReclassifiedWhileCategoryDeleted.id}`,
    {
      method: "PATCH",
      body: JSON.stringify({
        categoryIds: paperReclassifiedWhileCategoryDeleted.categoryIds,
      }),
    },
  );
  assert.equal(categoryEdit.response.status, 200);

  const restored = await jsonRequest(
    baseUrl,
    `/api/categories/${categoryId}/restore`,
    { method: "POST" },
  );
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.category.id, categoryId);
  assert.equal(restored.body.category.deletedAt, undefined);
  const linkedAfterRestore = restored.body.library.papers.filter((paper) =>
    paper.categoryIds.includes(categoryId),
  );
  assert.equal(linkedAfterRestore.length, linkedBefore.length - 1);
  assert.equal(
    linkedAfterRestore.some(
      (paper) => paper.id === paperPreservedWhileCategoryDeleted.id,
    ),
    true,
    "未提交 categoryIds 的编辑应保留可恢复关联",
  );
  assert.equal(
    linkedAfterRestore.some(
      (paper) => paper.id === paperReclassifiedWhileCategoryDeleted.id,
    ),
    false,
    "显式提交 categoryIds 后旧分类关联不应复活",
  );
});

test("分类恢复处理父级已删除与活动同名冲突", async (t) => {
  const fixture = await makeFixture(t, "category-restore-conflicts");
  const { baseUrl } = await fixture.start();

  const parent = await jsonRequest(baseUrl, "/api/categories", {
    method: "POST",
    body: JSON.stringify({ name: "临时父分类", parentId: null }),
  });
  const parentId = parent.body.category.id;
  const child = await jsonRequest(baseUrl, "/api/categories", {
    method: "POST",
    body: JSON.stringify({ name: "临时子分类", parentId }),
  });
  const childId = child.body.category.id;
  assert.equal(
    (
      await jsonRequest(baseUrl, `/api/categories/${childId}`, {
        method: "DELETE",
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await jsonRequest(baseUrl, `/api/categories/${parentId}`, {
        method: "DELETE",
      })
    ).response.status,
    200,
  );

  const childBeforeParent = await jsonRequest(
    baseUrl,
    `/api/categories/${childId}/restore`,
    { method: "POST" },
  );
  assert.equal(childBeforeParent.response.status, 409);
  assert.match(childBeforeParent.body.error.message, /先恢复上级/);

  assert.equal(
    (
      await jsonRequest(baseUrl, `/api/categories/${parentId}/restore`, {
        method: "POST",
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await jsonRequest(baseUrl, `/api/categories/${childId}/restore`, {
        method: "POST",
      })
    ).response.status,
    200,
  );

  assert.equal(
    (
      await jsonRequest(baseUrl, "/api/categories/HMWLPLJA", {
        method: "DELETE",
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await jsonRequest(baseUrl, "/api/categories", {
        method: "POST",
        body: JSON.stringify({
          name: "静态重建",
          parentId: "F6YQU7CN",
        }),
      })
    ).response.status,
    201,
  );
  const duplicateRestore = await jsonRequest(
    baseUrl,
    "/api/categories/HMWLPLJA/restore",
    { method: "POST" },
  );
  assert.equal(duplicateRestore.response.status, 409);
  assert.match(duplicateRestore.body.error.message, /同名/);
});

test("既有数据库幂等补列并迁移旧待看分类成员", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "library-api-migration-"));
  const dbPath = join(directory, "database", "library.sqlite3");
  const backupDir = join(directory, "backups");
  await mkdir(join(directory, "database"), { recursive: true });
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT REFERENCES categories(id) ON DELETE RESTRICT,
      source_kind TEXT NOT NULL DEFAULT 'local',
      source_key TEXT,
      source_parent_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO categories (
      id, name, parent_id, source_kind, sort_order, created_at, updated_at
    ) VALUES
      (
        'legacy-root', '旧分类', NULL, 'local', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'BGPSP4JY', '待看', NULL, 'zotero', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    CREATE TABLE papers (
      id TEXT PRIMARY KEY,
      zotero_key TEXT,
      title TEXT NOT NULL,
      zh_title TEXT NOT NULL DEFAULT '',
      authors TEXT NOT NULL DEFAULT '',
      institution TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      publication_date TEXT NOT NULL DEFAULT '',
      date_added TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('待读', '在读', '已读')),
      keywords_json TEXT NOT NULL DEFAULT '[]',
      ai_summary TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      note_count INTEGER CHECK (note_count IS NULL OR note_count >= 0),
      favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
      has_pdf INTEGER NOT NULL DEFAULT 0 CHECK (has_pdf IN (0, 1)),
      pdf_attachment_key TEXT,
      pdf_url TEXT,
      original_url TEXT,
      code_provider TEXT,
      code_url TEXT,
      project_provider TEXT,
      project_url TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    ) STRICT;
    INSERT INTO papers (
      id, title, status, sort_order, created_at, updated_at
    ) VALUES
      (
        'legacy-watched', '旧待看论文', '待读', 0,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'legacy-unwatched', '普通旧论文', '待读', 1,
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );

    CREATE TABLE paper_categories (
      paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (paper_id, category_id)
    ) STRICT;
    INSERT INTO paper_categories (paper_id, category_id, sort_order)
    VALUES ('legacy-watched', 'BGPSP4JY', 0);
  `);
  legacy.close();

  let api = await createLibraryApi({
    port: 0,
    dbPath,
    backupDir,
    seedPath: null,
  });
  let address = await api.listen();
  t.after(async () => {
    await api.close();
    await rm(directory, { recursive: true, force: true });
  });

  const categories = await jsonRequest(address.url, "/api/categories");
  assert.equal(categories.response.status, 200);
  assert.equal(categories.body.categories[0].id, "legacy-root");
  assert.equal(categories.body.categories[0].sidebarVisible, true);
  assert.equal(
    categories.body.categories.some(
      (category) => category.id === "BGPSP4JY",
    ),
    false,
  );
  assert.deepEqual(categories.body.deletedCategories, []);

  const library = await jsonRequest(address.url, "/api/library");
  const watched = library.body.papers.find(
    (paper) => paper.id === "legacy-watched",
  );
  const unwatched = library.body.papers.find(
    (paper) => paper.id === "legacy-unwatched",
  );
  assert.equal(watched.watchLater, true);
  assert.equal(unwatched.watchLater, false);
  assert.equal(Object.hasOwn(watched, "status"), false);
  assert.equal(Object.hasOwn(watched, "keywords"), false);
  assert.equal(
    findCategoryInTree(
      library.body.categories,
      "legacy-root",
    ).sidebarVisible,
    true,
  );

  const backupEntriesAfterMigration = await readdir(backupDir);
  assert.ok(
    backupEntriesAfterMigration.includes("library-latest.sqlite3"),
  );
  const migrationVersionCount = versionFiles(
    backupEntriesAfterMigration,
  ).length;
  assert.equal(migrationVersionCount, 1);

  await api.close();
  api = await createLibraryApi({
    port: 0,
    dbPath,
    backupDir,
    seedPath: null,
  });
  address = await api.listen();
  const afterRestart = await jsonRequest(
    address.url,
    "/api/categories",
  );
  assert.equal(
    afterRestart.body.categories.find(
      (category) => category.id === "legacy-root",
    ).sidebarVisible,
    true,
  );
  assert.equal(
    versionFiles(await readdir(backupDir)).length,
    migrationVersionCount,
    "重复启动不应重复执行迁移或生成迁移备份",
  );

  const migrated = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      migrated
        .prepare("PRAGMA table_info(categories)")
        .all()
        .some((column) => column.name === "deleted_at"),
      true,
    );
    assert.equal(
      migrated
        .prepare("PRAGMA table_info(categories)")
        .all()
        .some((column) => column.name === "sidebar_visible"),
      true,
    );
    assert.equal(
      Number(
        migrated
          .prepare(
            `SELECT sidebar_visible AS sidebarVisible
             FROM categories
             WHERE id = 'legacy-root'`,
          )
          .get().sidebarVisible,
      ),
      1,
    );
    assert.equal(
      migrated
        .prepare("PRAGMA table_info(papers)")
        .all()
        .some((column) => column.name === "watch_later"),
      true,
    );
    assert.equal(
      migrated
        .prepare("PRAGMA table_info(papers)")
        .all()
        .some((column) => column.name === "keywords_json"),
      false,
    );
    assert.equal(
      Number(
        migrated
          .prepare(
            `SELECT COUNT(*) AS count
             FROM repository_migrations
             WHERE id = 'legacy-watch-later-category-v1'`,
          )
          .get().count,
      ),
      1,
    );
    assert.equal(
      Number(
        migrated
          .prepare(
            `SELECT COUNT(*) AS count
             FROM repository_migrations
             WHERE id = 'remove-paper-keywords-v1'`,
          )
          .get().count,
      ),
      1,
    );
  } finally {
    migrated.close();
  }
});

test("iCloud 目录不可写时本地提交仍成功并返回备份警告", async (t) => {
  const fixture = await makeFixture(t, "backup-warning");
  await writeFile(fixture.backupDir, "这是文件，不是目录", "utf8");
  const { baseUrl } = await fixture.start();

  const result = await jsonRequest(
    baseUrl,
    "/api/papers/MQ2JQEDV",
    {
      method: "PATCH",
      body: JSON.stringify({ watchLater: true }),
    },
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.paper.watchLater, true);
  assert.equal(result.body.backup.ok, false);
  assert.match(result.body.backup.message, /本地修改已保存/);

  const library = await jsonRequest(baseUrl, "/api/library");
  assert.equal(
    library.body.papers.find((paper) => paper.id === "MQ2JQEDV")
      .watchLater,
    true,
  );
  assert.equal(library.body.backup.ok, false);
});
