import { sendJson } from "../library-api-http.mjs";
import {
  getKnowledgeOverview,
  getKnowledgePaper,
  knowledgeIncludeNotes,
  KnowledgeError,
  searchKnowledgePapers,
} from "../library-knowledge.mjs";

function queryInput(url, allowed) {
  const values = {};
  for (const [key, value] of url.searchParams) {
    const target = key === "q" ? "query" : key;
    if (!allowed.includes(key) || target in values) throw new KnowledgeError("包含不支持或重复的检索参数。");
    values[target] = value;
  }
  return values;
}

export async function handleKnowledgeRoutes({
  request,
  response,
  pathname,
  repository,
  allowKnowledgeNotes = true,
}) {
  if (pathname !== "/api/knowledge" && !pathname.startsWith("/api/knowledge/")) return false;
  if (request.method !== "GET") {
    sendJson(response, request, 405, { error: { code: "KNOWLEDGE_READ_ONLY", message: "论文库知识接口只支持只读 GET 检索。" } }, { Allow: "GET" });
    return true;
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (pathname === "/api/knowledge/overview") {
    const { includeNotes } = queryInput(url, ["includeNotes"]);
    sendJson(response, request, 200, getKnowledgeOverview(repository.getLibrary(), { includeNotes: knowledgeIncludeNotes(includeNotes) && allowKnowledgeNotes }));
    return true;
  }
  if (pathname === "/api/knowledge/search") {
    const input = queryInput(url, ["q", "limit", "offset", "categoryId", "favorite", "watchLater", "includeNotes"]);
    sendJson(response, request, 200, searchKnowledgePapers(repository.getLibrary(), input, { allowNotes: allowKnowledgeNotes }));
    return true;
  }
  const match = pathname.match(/^\/api\/knowledge\/papers\/([^/]+)$/u);
  if (match) {
    let id;
    try { id = decodeURIComponent(match[1]); } catch { throw new KnowledgeError("论文 ID 编码无效。"); }
    const { includeNotes } = queryInput(url, ["includeNotes"]);
    sendJson(response, request, 200, getKnowledgePaper(repository.getLibrary(), id, { includeNotes: knowledgeIncludeNotes(includeNotes) && allowKnowledgeNotes }));
    return true;
  }
  sendJson(response, request, 404, { error: { code: "KNOWLEDGE_ROUTE_NOT_FOUND", message: "未找到论文库检索接口。" } });
  return true;
}
