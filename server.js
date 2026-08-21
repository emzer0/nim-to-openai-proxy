const express = require("express");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 10000;
const PUTER_AUTH_TOKEN = process.env.PUTER_AUTH_TOKEN;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY || "";
const PUTER_BASE_URL =
  "https://api.puter.com/puterai/openai/v1";
const DEFAULT_MODEL =
  "moonshotai/kimi-k2.6";
if (!PUTER_AUTH_TOKEN) {
  console.error("[FATAL] PUTER_AUTH_TOKEN is missing.");
  process.exit(1);
}
app.use(cors());
app.use(
  express.json({
    limit: "50mb"
  })
);
// ============================================================
// AUTH
// ============================================================
function authenticate(req, res, next) {
  // Public endpoints
  if (
    req.path === "/" ||
    req.path === "/health"
  ) {
    return next();
  }
  // /v1/models is also public unless CLIENT_AUTH_KEY is set
  if (
    req.path === "/v1/models" &&
    !CLIENT_AUTH_KEY
  ) {
    return next();
  }
  // No client key configured = no proxy auth
  if (!CLIENT_AUTH_KEY) {
    return next();
  }
  const authorization =
    req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) {
    return res.status(401).json({
      error: {
        message: "Missing proxy authentication",
        type: "authentication_error",
        code: 401
      }
    });
  }
  const token =
    authorization.slice(7);
  if (token !== CLIENT_AUTH_KEY) {
    return res.status(401).json({
      error: {
        message: "Invalid proxy authentication",
        type: "authentication_error",
        code: 401
      }
    });
  }
  next();
}
app.use(authenticate);
// ============================================================
// ROOT
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    service: "Puter OpenAI-compatible proxy",
    provider: "puter",
    model: DEFAULT_MODEL
  });
});
// ============================================================
// HEALTH
// ============================================================
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    provider: "puter",
    model: DEFAULT_MODEL,
    context_tokens: 262144,
    max_output_tokens: 262144,
    streaming: true,
    openai_compatible: true,
    version: "9.0.0"
  });
});
// ============================================================
// MODELS
//
// IMPORTANT:
// We do NOT call Puter /models anymore.
// We expose the models we know Puter supports directly.
// This avoids the previous 404 problem.
// ============================================================
app.get("/v1/models", (req, res) => {
  const now =
    Math.floor(Date.now() / 1000);
  return res.json({
    object: "list",
    data: [
      {
        id: "moonshotai/kimi-k2.6",
        object: "model",
        created: now,
        owned_by: "puter"
      },
      {
        id: "moonshotai/kimi-k3",
        object: "model",
        created: now,
        owned_by: "puter"
      },
      {
        id: "z-ai/glm-5.2",
        object: "model",
        created: now,
        owned_by: "puter"
      },
      {
        id: "openai/gpt-5.5",
        object: "model",
        created: now,
        owned_by: "puter"
      }
    ]
  });
});
// ============================================================
// CHAT COMPLETIONS
// ============================================================
app.post(
  "/v1/chat/completions",
  async (req, res) => {
    try {
      const body = req.body || {};
      if (
        !Array.isArray(body.messages) ||
        body.messages.length === 0
      ) {
        return res.status(400).json({
          error: {
            message:
              "messages must be a non-empty array",
            type:
              "invalid_request_error",
            code: 400
          }
        });
      }
      // --------------------------------------------------------
      // MODEL
      // --------------------------------------------------------
      const requestedModel =
        body.model || DEFAULT_MODEL;
      // --------------------------------------------------------
      // BUILD CLEAN OPENAI REQUEST
      // --------------------------------------------------------
      const requestBody = {
        ...body,
        model: requestedModel
      };
      // Fields that Janitor/proxies may send
      // but Puter may not need.
      delete requestBody.provider;
      // Don't send proxy-specific fields upstream.
      delete requestBody.api_key;
      delete requestBody.proxy;
      delete requestBody.proxy_url;
      // --------------------------------------------------------
      // STREAM
      // --------------------------------------------------------
      if (
        requestBody.stream !== undefined
      ) {
        requestBody.stream =
          Boolean(requestBody.stream);
      }
      const isStreaming =
        Boolean(requestBody.stream);
      console.log(
        `[REQUEST] model=${requestedModel} ` +
        `stream=${isStreaming} ` +
        `messages=${body.messages.length}`
      );
      // ========================================================
      // UPSTREAM REQUEST
      // ========================================================
      const upstream =
        await fetch(
          `${PUTER_BASE_URL}/chat/completions`,
          {
            method: "POST",
            headers: {
              "Authorization":
                `Bearer ${PUTER_AUTH_TOKEN}`,
              "Content-Type":
                "application/json",
              "Accept":
                isStreaming
                  ? "text/event-stream"
                  : "application/json"
            },
            body:
              JSON.stringify(requestBody)
          }
        );
      console.log(
        `[UPSTREAM] HTTP ${upstream.status}`
      );
      // ========================================================
      // STREAMING
      // ========================================================
      if (isStreaming) {
        res.status(
          upstream.status
        );
        const contentType =
          upstream.headers.get(
            "content-type"
          );
        res.setHeader(
          "Content-Type",
          contentType ||
            "text/event-stream; charset=utf-8"
        );
        res.setHeader(
          "Cache-Control",
          "no-cache, no-transform"
        );
        res.setHeader(
          "Connection",
          "keep-alive"
        );
        res.setHeader(
          "X-Accel-Buffering",
          "no"
        );
        res.flushHeaders();
        if (!upstream.body) {
          return res.end();
        }
        const reader =
          upstream.body.getReader();
        try {
          while (true) {
            const result =
              await reader.read();
            if (result.done) {
              break;
            }
            if (
              !res.writableEnded
            ) {
              res.write(
                Buffer.from(
                  result.value
                )
              );
            }
          }
        } catch (error) {
          console.error(
            "[STREAM ERROR]",
            error.message
          );
        } finally {
          if (
            !res.writableEnded
          ) {
            res.end();
          }
        }
        return;
      }
      // ========================================================
      // NON-STREAMING
      // ========================================================
      const text =
        await upstream.text();
      if (!text) {
        return res.status(
          upstream.ok
            ? 200
            : upstream.status
        ).json(
          upstream.ok
            ? {}
            : {
                error: {
                  message:
                    `Puter returned HTTP ${upstream.status}`,
                  type:
                    "upstream_error",
                  code:
                    upstream.status,
                  upstream:
                    "puter"
                }
              }
        );
      }
      let data;
      try {
        data =
          JSON.parse(text);
      } catch {
        data = {
          error: {
            message:
              text,
            type:
              "upstream_error",
            code:
              upstream.status,
            upstream:
              "puter"
          }
        };
      }
      if (!upstream.ok) {
        console.error(
          `[PUTER ERROR] HTTP ${upstream.status}`
        );
        console.error(
          text
        );
        return res
          .status(upstream.status)
          .json({
            error: {
              message:
                data?.error?.message ||
                text ||
                `Puter returned HTTP ${upstream.status}`,
              type:
                data?.error?.type ||
                "upstream_error",
              code:
                upstream.status,
              upstream:
                "puter"
            }
          });
      }
      return res.json(data);
    } catch (error) {
      console.error(
        "[PROXY ERROR]",
        error
      );
      return res.status(500).json({
        error: {
          message:
            error.message ||
            "Internal proxy error",
          type:
            "proxy_error",
          code:
            500,
          upstream:
            "puter"
        }
      });
    }
  }
);
// ============================================================
// 404
// ============================================================
app.use(
  (req, res) => {
    res.status(404).json({
      error: {
        message:
          `Endpoint ${req.method} ${req.path} not found`,
        type:
          "invalid_request_error",
        code:
          404
      }
    });
  }
);
// ============================================================
// START
// ============================================================
app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      "================================================"
    );
    console.log(
      "[PROXY] Puter → OpenAI-compatible proxy"
    );
    console.log(
      `[PROXY] Port: ${PORT}`
    );
    console.log(
      "[PROXY] Provider: Puter"
    );
    console.log(
      `[PROXY] Default model: ${DEFAULT_MODEL}`
    );
    console.log(
      "[PROXY] Streaming: ENABLED"
    );
    console.log(
      "[PROXY] OpenAI-compatible: YES"
    );
    console.log(
      "================================================"
    );
  }
);
