import {
  assertAiRequestOrigin,
  readJsonBody,
  routeAiConnection,
  routeAiModel,
  sendJson,
} from "../library-api-http.mjs";

export async function handleAiRoutes({
  request,
  response,
  pathname,
  aiService,
}) {
  if (request.method === "GET" && pathname === "/api/ai/settings") {
    assertAiRequestOrigin(request);
    sendJson(response, request, 200, await aiService.getSettings());
    return true;
  }

  if (request.method === "POST" && pathname === "/api/ai/connections") {
    assertAiRequestOrigin(request);
    const result = await aiService.verifyAndSave(
      null,
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }

  const verifyAiConnection = routeAiConnection(pathname, "models/verify");
  if (request.method === "POST" && verifyAiConnection !== null) {
    assertAiRequestOrigin(request);
    const result = await aiService.verifyAndSave(
      verifyAiConnection,
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }

  const activeAiModel = routeAiModel(pathname, "active");
  if (request.method === "PUT" && activeAiModel !== null) {
    assertAiRequestOrigin(request);
    const result = await aiService.setActiveModel(activeAiModel);
    sendJson(response, request, 200, result);
    return true;
  }

  const aiModel = routeAiModel(pathname);
  if (request.method === "PATCH" && aiModel !== null) {
    assertAiRequestOrigin(request);
    const result = await aiService.updateModelReasoningEffort(
      aiModel,
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }
  if (request.method === "DELETE" && aiModel !== null) {
    assertAiRequestOrigin(request);
    const result = await aiService.deleteModel(aiModel);
    sendJson(response, request, 200, result);
    return true;
  }

  const aiConnection = routeAiConnection(pathname);
  if (request.method === "PATCH" && aiConnection !== null) {
    assertAiRequestOrigin(request);
    const result = await aiService.updateConnection(
      aiConnection,
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }
  if (request.method === "DELETE" && aiConnection !== null) {
    assertAiRequestOrigin(request);
    const result = await aiService.deleteConnection(aiConnection);
    sendJson(response, request, 200, result);
    return true;
  }

  return false;
}
