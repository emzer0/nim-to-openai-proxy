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
  if (
    req.path === "/" ||
    req.path === "/health" ||
    req.path === "/v1/models"
  ) {
    return next();
  }
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
  const token = authorization.substring(7);
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
    service: "Puter Kimi K2.6 OpenAI-compatible proxy",
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
    version: "8.0.0"
  });
});
// ============================================================
// MODELS
// ============================================================
app.get("/v1/models", async (req, res) => {
  try {
    const response = await fetch(
      `${PUTER_BASE_URL}/models`,
      {
        method: "GET",
        headers: {
          Authorization:
            `Bearer ${PUTER_AUTH_TOKEN}`,
          Accept: "application/json"
        }
      }
    );
    const text = await response.text();
    console.log(
      `[PUTER MODELS] HTTP ${response.status}`
    );
    if (!response.ok) {
      console.error(text);
      return res.status(response.status).json({
        error: {
          message:
            `Puter returned HTTP ${response.status}`,
          type: "upstream_error",
          code: response.status,
          upstream: "puter"
        }
      });
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: {
          message:
            "Puter returned invalid JSON",
          type: "upstream_error",
          code: 502,
          upstream: "puter"
        }
      });
    }
    return res.json(data);
  } catch (error) {
    console.error(
      "[MODELS ERROR]",
      error
    );
    return res.status(500).json({
      error: {
        message: error.message,
        type: "proxy_error",
        code: 500,
        upstream: "puter"
      }
    });
  }
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
      // IMPORTANT:
      // Always use Kimi K2.6.
      // --------------------------------------------------------
      const requestBody = {
        ...body,
        model: DEFAULT_MODEL
      };
      // Remove proxy/provider-specific fields.
      delete requestBody.provider;
      if (
        requestBody.stream !== undefined
      ) {
        requestBody.stream =
          Boolean(requestBody.stream);
      }
      console.log(
        "================================================"
      );
      console.log(
        `[REQUEST] model=${requestBody.model}`
      );
      console.log(
        `[REQUEST] stream=${Boolean(requestBody.stream)}`
      );
      console.log(
        `[REQUEST] messages=${requestBody.messages.length}`
      );
      console.log(
        "================================================"
      );
      // ========================================================
      // SEND DIRECTLY TO PUTER OPENAI API
      // ========================================================
      const upstream =
        await fetch(
          `${PUTER_BASE_URL}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${PUTER_AUTH_TOKEN}`,
              "Content-Type":
                "application/json",
              Accept:
                requestBody.stream
                  ? "text/event-stream"
                  : "application/json"
            },
            body:
              JSON.stringify(requestBody)
          }
        );
      console.log(
        `[PUTER] HTTP ${upstream.status}`
      );
      // ========================================================
      // STREAMING
      // ========================================================
      if (requestBody.stream) {
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
          "text/event-stream"
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
        if (!upstream.body) {
          return res.end();
        }
        const reader =
          upstream.body.getReader();
        try {
          while (true) {
            const {
              done,
              value
            } =
              await reader.read();
            if (done) {
              break;
            }
            if (!res.writableEnded) {
              res.write(
                Buffer.from(value)
              );
            }
          }
        } catch (streamError) {
          console.error(
            "[STREAM ERROR]",
            streamError.message
          );
        } finally {
          if (!res.writableEnded) {
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
      if (!upstream.ok) {
        console.error(
          `[PUTER ERROR] HTTP ${upstream.status}`
        );
        console.error(text);
        let upstreamData = null;
        try {
          upstreamData =
            JSON.parse(text);
        } catch {}
        return res
          .status(upstream.status)
          .json({
            error: {
              message:
                upstreamData?.error?.message ||
                text ||
                `Puter returned HTTP ${upstream.status}`,
              type:
                upstreamData?.error?.type ||
                "upstream_error",
              code:
                upstream.status,
              upstream:
                "puter",
              model:
                DEFAULT_MODEL
            }
          });
      }
      let data;
      try {
        data =
          JSON.parse(text);
      } catch {
        return res.status(502).json({
          error: {
            message:
              "Puter returned invalid JSON",
            type:
              "upstream_error",
            code:
              502,
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
            error.message,
          type:
            "proxy_error",
          code:
            500,
          upstream:
            "puter",
          model:
            DEFAULT_MODEL
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
      "[PROXY] Puter Kimi K2.6 proxy is running"
    );
    console.log(
      `[PROXY] Port: ${PORT}`
    );
    console.log(
      `[PROXY] Model: ${DEFAULT_MODEL}`
    );
    console.log(
      "[PROXY] Context: 262144"
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
