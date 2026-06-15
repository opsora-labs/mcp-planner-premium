import { randomUUID } from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";
import { requestContext } from "./context.js";
import {
  getEnv,
  getAudiences,
  getAllowedHosts,
  getAllowedOrigins,
} from "./config.js";
import { logger } from "./logger.js";
import { verifyAccessToken, TokenValidationError } from "./auth.js";
import { errMessage } from "./dataverse.js";

/** Shared lifecycle flag so the health route can report draining state. */
export const state = { shuttingDown: false };

/** Pulls the bearer token from the inbound Authorization header (if any). */
export function extractBearer(req: Request): string {
  const header = req.headers["authorization"];
  if (!header || Array.isArray(header)) return "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function send401(res: Response, error: string, description: string): void {
  res
    .status(401)
    .set(
      "WWW-Authenticate",
      `Bearer error="${error}", error_description="${description}"`,
    )
    .json({
      jsonrpc: "2.0",
      error: { code: -32001, message: description },
      id: null,
    });
}

/** Builds the Express app (no listen). The entrypoint and tests both use this. */
export function buildApp(): Express {
  const env = getEnv();

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => {
        const id = randomUUID();
        res.setHeader("x-request-id", id);
        return id;
      },
      autoLogging: true, // metadata only; bodies are never logged
    }),
  );
  app.use(express.json({ limit: env.JSON_BODY_LIMIT }));

  // Liveness/readiness probe. 503 while draining so ACA stops routing here.
  app.get("/healthz", (_req: Request, res: Response) => {
    if (state.shuttingDown) {
      res.status(503).json({ ok: false, status: "shutting_down" });
      return;
    }
    res.json({ ok: true, service: "mcp-planner-premium" });
  });

  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: env.RATE_LIMIT_PER_MIN,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Stateless MCP over Streamable HTTP: one server + transport per request.
  app.post("/mcp", mcpLimiter, async (req: Request, res: Response) => {
    const bearer = extractBearer(req);

    if (env.AUTH_MODE === "validate") {
      if (!bearer) {
        send401(res, "missing_token", "Authorization Bearer token is required.");
        return;
      }
      try {
        await verifyAccessToken(bearer, {
          tenantId: env.TENANT_ID as string,
          audience: getAudiences(),
          clientId: env.ENTRA_CLIENT_ID,
        });
      } catch (e: unknown) {
        logger.warn({ err: errMessage(e) }, "inbound_token_rejected");
        send401(
          res,
          "invalid_token",
          e instanceof TokenValidationError ? e.message : "Invalid token.",
        );
        return;
      }
    }

    const allowedHosts = getAllowedHosts();
    const allowedOrigins = getAllowedOrigins();
    const dnsProtection =
      allowedHosts || allowedOrigins
        ? { enableDnsRebindingProtection: true, allowedHosts, allowedOrigins }
        : {};

    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      ...dnsProtection,
    });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await requestContext.run({ bearer }, () =>
        transport.handleRequest(req, res, req.body),
      );
    } catch (err) {
      logger.error({ err: errMessage(err) }, "mcp_request_failed");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode supports neither GET streams nor DELETE teardown.
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  return app;
}
