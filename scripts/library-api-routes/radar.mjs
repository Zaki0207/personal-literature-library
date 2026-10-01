import {
  assertAiRequestOrigin,
  readJsonBody,
  routeRadarItem,
  sendJson,
} from "../library-api-http.mjs";

export async function handleRadarRoutes({
  request,
  response,
  pathname,
  repository,
  literatureRadarService,
}) {
  if (request.method === "GET" && pathname === "/api/radar") {
    assertAiRequestOrigin(request);
    sendJson(response, request, 200, literatureRadarService.getState());
    return true;
  }

  if (request.method === "GET" && pathname === "/api/radar/ai-trace") {
    assertAiRequestOrigin(request);
    sendJson(response, request, 200, {
      trace: literatureRadarService.getAiTrace(),
    });
    return true;
  }

  if (
    request.method === "GET" &&
    pathname === "/api/radar/prompt-template/default"
  ) {
    assertAiRequestOrigin(request);
    sendJson(response, request, 200, {
      promptTemplate: literatureRadarService.getDefaultPromptTemplate(),
    });
    return true;
  }

  if (
    request.method === "PUT" &&
    pathname === "/api/radar/prompt-template"
  ) {
    assertAiRequestOrigin(request);
    const body = await readJsonBody(request);
    const result = await literatureRadarService.savePromptTemplate(
      body?.promptTemplate,
    );
    sendJson(response, request, 200, result);
    return true;
  }

  if (request.method === "POST" && pathname === "/api/radar/run") {
    assertAiRequestOrigin(request);
    const result = await literatureRadarService.run(
      await readJsonBody(request),
    );
    sendJson(response, request, 200, result);
    return true;
  }

  const discardRadarItemId = routeRadarItem(pathname, "discard");
  if (request.method === "POST" && discardRadarItemId !== null) {
    assertAiRequestOrigin(request);
    await repository.discardRadarItem(discardRadarItemId);
    sendJson(response, request, 200, repository.getRadarState());
    return true;
  }

  const restoreRadarItemId = routeRadarItem(pathname, "restore");
  if (request.method === "POST" && restoreRadarItemId !== null) {
    assertAiRequestOrigin(request);
    await repository.restoreRadarItem(restoreRadarItemId);
    sendJson(response, request, 200, repository.getRadarState());
    return true;
  }

  const addRadarItemId = routeRadarItem(pathname, "add");
  if (request.method === "POST" && addRadarItemId !== null) {
    assertAiRequestOrigin(request);
    const created = await repository.createPaperFromRadarItem(
      addRadarItemId,
      await readJsonBody(request),
    );
    sendJson(response, request, 201, {
      paper: created.paper,
      library: repository.getLibrary(),
      radar: repository.getRadarState(),
    });
    return true;
  }

  return false;
}
