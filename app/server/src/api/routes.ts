import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { DB } from "../index/db.js";
import { applicationsPlugin } from "./applications.js";
import { cvOrchestratorPlugin } from "./cvOrchestrator.js";
import { fullReportOrchestratorPlugin } from "./fullReportOrchestrator.js";
import { linkedinPipelinePlugin } from "./linkedinPipelineRoutes.js";
import { reportsPlugin } from "./reports.js";
import { indexSsePlugin } from "./sse.js";

declare module "fastify" {
  interface FastifyInstance {
    indexDb: DB;
  }
}

export type ApiPluginOpts = {
  db: DB;
};

export const apiPlugin = (opts: ApiPluginOpts): FastifyPluginAsync => {
  return async (app: FastifyInstance) => {
    if (!app.hasDecorator("indexDb")) {
      app.decorate("indexDb", opts.db);
    }
    await app.register(applicationsPlugin);
    await app.register(reportsPlugin);
    await app.register(cvOrchestratorPlugin);
    await app.register(fullReportOrchestratorPlugin);
    await app.register(linkedinPipelinePlugin);
    await app.register(indexSsePlugin);
  };
};
