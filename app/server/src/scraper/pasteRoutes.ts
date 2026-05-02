import type { FastifyInstance, FastifyPluginAsync } from "fastify";

import type { PasteRequest, PasteResponse } from "@job-seeker/shared";

import { extractFromPaste } from "./paste.js";

const MAX_BODY_BYTES = 1024 * 1024;

export const pastePlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{
    Body: Partial<PasteRequest>;
    Reply: PasteResponse | { error: string };
  }>(
    "/api/scraper/paste",
    {
      bodyLimit: MAX_BODY_BYTES + 8 * 1024,
    },
    async (request, reply) => {
      const body = request.body ?? {};
      const html = typeof body.html === "string" ? body.html : "";
      const plainText = typeof body.plainText === "string" ? body.plainText : "";

      const htmlBytes = Buffer.byteLength(html, "utf8");
      const plainBytes = Buffer.byteLength(plainText, "utf8");
      if (htmlBytes > MAX_BODY_BYTES || plainBytes > MAX_BODY_BYTES) {
        return reply.code(413).send({ error: "paste exceeds 1 MB" });
      }

      const hasHtml = html.trim().length > 0;
      const hasPlain = plainText.trim().length > 0;
      if (hasHtml && hasPlain) {
        return reply
          .code(400)
          .send({ error: "pass exactly one of html or plainText" });
      }
      if (!hasHtml && !hasPlain) {
        return reply
          .code(400)
          .send({ error: "pass exactly one of html or plainText" });
      }

      const result = extractFromPaste({
        html: hasHtml ? html : undefined,
        plainText: hasPlain ? plainText : undefined,
      });
      return reply.code(200).send(result);
    },
  );
};

export default pastePlugin;
