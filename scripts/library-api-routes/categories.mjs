import {
  readJsonBody,
  readOptionalJsonBody,
  routeCategoryId,
  sendJson,
} from "../library-api-http.mjs";

export async function handleCategoryRoutes({
  request,
  response,
  pathname,
  repository,
}) {
  if (request.method === "GET" && pathname === "/api/categories") {
    sendJson(response, request, 200, repository.getCategories());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/categories") {
    const result = await repository.createCategory(await readJsonBody(request));
    sendJson(response, request, 201, result);
    return true;
  }

  if (request.method === "PUT" && pathname === "/api/categories/reorder") {
    const result = await repository.reorderCategories(
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }

  const restoreCategoryId = routeCategoryId(pathname, "restore");
  if (request.method === "POST" && restoreCategoryId !== null) {
    const result = await repository.restoreCategory(restoreCategoryId);
    sendJson(response, request, 200, result);
    return true;
  }

  const categoryId = routeCategoryId(pathname);
  if (request.method === "PATCH" && categoryId !== null) {
    const result = await repository.updateCategory(
      categoryId,
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }
  if (request.method === "DELETE" && categoryId !== null) {
    const result = await repository.deleteCategory(
      categoryId,
      await readOptionalJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }

  return false;
}
