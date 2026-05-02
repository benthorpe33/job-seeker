import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { ScrapeRequest, ScrapeResponse } from "@job-seeker/shared";

import { scrapeForm } from "./scrapeForm.js";

function isValidUrl(s: unknown): s is string {
  if (typeof s !== "string" || !s.trim()) return false;
  try {
    const u = new URL(s.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export const scraperPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{
    Body: Partial<ScrapeRequest>;
    Reply: ScrapeResponse | { error: string };
  }>("/api/scraper/scan", async (request, reply) => {
    const applyUrl = request.body?.applyUrl;
    if (!isValidUrl(applyUrl)) {
      return reply.code(400).send({ error: "applyUrl missing or malformed" });
    }
    try {
      const result = await scrapeForm(applyUrl);
      return reply.code(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = /timeout/i.test(message);
      return reply
        .code(isTimeout ? 504 : 502)
        .send({ error: message });
    }
  });
};

export default scraperPlugin;
