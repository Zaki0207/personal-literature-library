import { Readable } from "node:stream";
import { ValidationError } from "../library-repository.mjs";
import { routePaperId, sendJson, sendSupplementFile } from "../library-api-http.mjs";

export async function handleSupplementRoutes({ request, response, pathname, searchParams, paperSupplementsService }) {
  const match = /^(\/api\/papers\/[^/]+\/supplements)(?:\/([^/]+))?$/u.exec(pathname);
  if (!match) return false;
  const [, collectionPath, id] = match;
  const paperId = routePaperId(collectionPath, "supplements");
  if (!id && request.method === "POST") {
    if (request.headers["content-type"] !== "application/octet-stream") {
      throw new ValidationError("请选择要添加的补充材料文件。");
    }
    const input = Readable.from(request.iterator({ destroyOnReturn: false }));
    const result = await paperSupplementsService.importFile(paperId, searchParams.get("name"), input, Number(request.headers["content-length"] ?? 0));
    sendJson(response, request, result.alreadyImported ? 200 : 201, result);
    return true;
  }
  if (id && request.method === "GET") {
    sendSupplementFile(response, request, await paperSupplementsService.getLocalFile(paperId, id));
    return true;
  }
  if (id && request.method === "DELETE") {
    sendJson(response, request, 200, await paperSupplementsService.remove(paperId, id));
    return true;
  }
  return false;
}
