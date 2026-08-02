import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));

async function filesUnder(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the literature knowledge base", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>我的文献库<\/title>/i);
  assert.match(html, /全部论文/);
  assert.match(html, /view-overview/);
  assert.match(html, /0(?:<!-- -->)? 篇/);
  assert.match(html, /aria-controls="library-sidebar"/);
  assert.match(html, /aria-label="隐藏侧边栏"/);
  assert.match(html, />管理</);
  assert.match(html, /添加论文/);
  assert.match(html, /AI 设置/);
  assert.match(html, />近期想看</);
  assert.match(html, />题目列表</);
  assert.match(html, /正在连接本机数据库/);
  assert.match(html, /没有符合当前条件的论文/);
  assert.doesNotMatch(html, />\s*(?:undefined|null)\s*</);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps the agreed navigation and resource states in the product source", async () => {
  const [page, styles, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /renderSidebarCategory/);
  assert.match(page, /renderCategoryEditorCategory/);
  assert.match(page, /flattenCategoryTree/);
  assert.match(page, /visibleSidebarCategories/);
  assert.match(page, /activeCategory\.outlineNumber/);
  assert.match(page, /paperMatchesNonScopeFilters/);
  assert.match(page, /papersMatchingActiveFilters/);
  assert.match(
    page,
    /activeScope === "uncategorized" \? "all" : "uncategorized"/,
  );
  assert.match(page, /quickNavigationItems/);
  assert.match(page, /className="view-overview"/);
  assert.match(page, /className="quick-navigation"/);
  assert.match(page, /setManagedCategorySidebarVisibility/);
  assert.match(page, /在侧栏显示“\$\{category\.name\}”/);
  assert.match(page, /侧栏显示/);
  assert.match(page, /sidebarVisible/);
  assert.match(page, /toggleSidebarVisibility/);
  assert.match(page, /literature-sidebar-collapsed/);
  assert.match(page, /is-sidebar-collapsed/);
  assert.match(page, /aria-controls="library-sidebar"/);
  assert.match(page, /最多支持三级分类/);
  assert.match(page, /watchLaterOnly/);
  assert.match(page, /paper\.watchLater/);
  assert.match(page, /favoriteOnly/);
  assert.match(page, /legacyWatchCategoryIds/);
  assert.match(page, /className="resource-slot is-available"/);
  assert.match(page, /className="resource-slot is-missing"/);
  assert.match(page, /paper\.hasPdf/);
  assert.match(page, /href=\{codeUrl\}/);
  assert.match(page, /href=\{projectUrl\}/);
  assert.match(page, /target="_blank"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.match(page, /有代码/);
  assert.match(page, /有项目主页/);
  assert.match(page, /paper-card-text-size/);
  assert.match(page, /card-size-\$\{cardTextSize\}/);
  assert.match(page, /paper-view-mode/);
  assert.match(page, /paperViewMode === "titles"/);
  assert.match(page, /className="paper-title-list"/);
  assert.match(page, /data-title-paper=\{paper\.id\}/);
  assert.match(page, /openTitlePreview/);
  assert.match(page, /createPortal/);
  assert.match(page, /renderPaperCard\(titlePreviewPaper\)/);
  assert.match(page, /className="paper-preview-layer"/);
  assert.match(styles, /\.paper-title-list li/);
  assert.match(styles, /\.paper-preview-dialog/);
  assert.match(page, /LIBRARY_API_BASE/);
  assert.match(page, /编辑论文/);
  assert.match(page, /className="edit-drawer"/);
  assert.match(page, /role="dialog"/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /放弃未保存的修改/);
  assert.match(page, /Control\+S Meta\+S Control\+Enter Meta\+Enter/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /撤销/);
  assert.match(page, /AI 总结/);
  assert.match(page, /我的笔记/);
  assert.match(page, /selectedCategoryIds/);
  assert.match(page, /sameCategorySelection/);
  assert.match(page, /analyzePaperReference/);
  assert.match(page, /\/paper-intake\/analyze/);
  assert.match(page, /识别与查重/);
  assert.match(page, /元数据与 AI/);
  assert.match(page, /确认添加到知识库/);
  assert.match(page, /addingPaperRef\.current/);
  assert.match(page, /disabled=\{addingPaper\}/);
  assert.match(page, /分类管理/);
  assert.match(page, /className="manage-categories-button"/);
  assert.match(page, /className="toolbar-button ai-settings-button"/);
  assert.match(page, /type="password"/);
  assert.match(page, /autoComplete="new-password"/);
  assert.match(page, /验证并添加/);
  assert.match(page, /API Key 只保存在 macOS 钥匙串/);
  assert.match(page, /服务连接/);
  assert.match(page, /已添加模型/);
  assert.match(page, /activeModelId/);
  assert.match(page, /直接 \{category\.directCount\} · 合计 \{category\.totalCount\}/);
  assert.match(page, /最近删除/);
  assert.match(page, /放弃未保存的分类修改/);
  assert.match(page, /\/categories\/\$\{encodeURIComponent\(category\.id\)\}\/restore/);
  assert.match(page, /paperPolicy: "detach"/);
  assert.match(page, /method: "PATCH"/);
  assert.match(page, /onSubmit=\{renameManagedCategory\}/);
  assert.match(page, /onSubmit=\{moveManagedCategory\}/);
  assert.match(page, /lastDeletedCategory \? 10_000/);
  assert.doesNotMatch(page, /className="new-category-button"/);
  assert.doesNotMatch(page, /<p className="nav-caption">知识库<\/p>/);
  assert.doesNotMatch(
    page,
    /ReadingStatus|statusSequence|cycleStatus|unreadOnly|paper\.status|editDraft\.status|阅读状态|分类与阅读/,
  );
  assert.doesNotMatch(
    page,
    /PERSONAL RESEARCH|ORGANIZE LIBRARY|DELETE CATEGORY|UNSAVED CHANGES|EDIT PAPER|ADD PAPER/,
  );
  assert.doesNotMatch(page, /library-data\.json/);
  assert.match(layout, /lang="zh-CN"/);
  assert.match(styles, /\.sidebar\.is-collapsed/);
  assert.match(styles, /\.main-content\.is-sidebar-collapsed/);
  assert.match(styles, /\.view-overview\s*\{[^}]*min-height:\s*72px/s);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
});

test("does not package the local private seed into the deployment build", async (t) => {
  let seed;
  try {
    seed = JSON.parse(
      await readFile(
        join(PROJECT_DIRECTORY, "local-data", "library-data.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("本机没有私有种子文件");
      return;
    }
    throw error;
  }

  const privateTitles = seed.papers
    .map((paper) => String(paper.title ?? "").trim())
    .filter(Boolean);
  assert.ok(privateTitles.length > 0);

  const buildFiles = await filesUnder(join(PROJECT_DIRECTORY, "dist"));
  const buildText = (
    await Promise.all(
      buildFiles.map((path) => readFile(path).catch(() => Buffer.alloc(0))),
    )
  )
    .map((value) => value.toString("utf8"))
    .join("\n");

  assert.equal(
    privateTitles.some((title) => buildText.includes(title)),
    false,
    "部署构建不应包含本机私人文献标题",
  );
});
