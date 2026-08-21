const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;

const PUTER_AUTH_TOKEN = process.env.PUTER_AUTH_TOKEN;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY || "";

const PUTER_BASE_URL =
  "https://api.puter.com/puterai/openai/v1";

if (!PUTER_AUTH_TOKEN) {
  console.error("[FATAL] PUTER_AUTH_TOKEN is missing.");
  process.exit(1);
}

app.use(cors());

app.use(
  express.json({
    limit: "20mb"
  })
);

// ============================================================
// AUTH
// ============================================================

function authenticate(req, res, next) {
  // These endpoints are public.
  if (
    req.path === "/" ||
    req.path === "/health" ||
    req.path === "/v1/models"
  ) {
    return next();
  }

  // If CLIENT_AUTH_KEY is not configured,
  // allow the request through.
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
    authorization.substring(7);

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
    provider: "puter"
  });
});

// ============================================================
// HEALTH
// ============================================================

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    provider: "puter",
    streaming: true,
    openai_compatible: true,
    version: "6.0.0"
  });
});

// ============================================================
// MODELS
// ============================================================

app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "z-ai/glm-5.2",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "puter"
      },
      {
        id: "moonshotai/kimi-k2.6",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "puter"
      },
      {
        id: "openai/gpt-5.5",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "puter"
      }
    ]
  });
});

    const text =
      await response.text();

    if (!response.ok) {
      console.error(
        `[PUTER MODELS] HTTP ${response.status}`,
        text
      );

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
      error.message
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

      /*
       * IMPORTANT:
       *
       * We intentionally do NOT replace the model.
       *
       * Janitor can send:
       *
       *   "model": "..."
       *
       * and Puter receives exactly that model.
       *
       * This allows switching between models
       * without changing the Render proxy.
       */

      const requestBody = {
        ...body
      };

      // --------------------------------------------------------
      // Remove fields that can cause compatibility problems.
      // --------------------------------------------------------

      delete requestBody.provider;

      // --------------------------------------------------------
      // Make sure stream is boolean when supplied.
      // --------------------------------------------------------

      if (
        requestBody.stream !== undefined
      ) {
        requestBody.stream =
          Boolean(requestBody.stream);
      }

      console.log(
        `[REQUEST] model=${requestBody.model || "unknown"} ` +
        `stream=${Boolean(requestBody.stream)}`
      );

      // ========================================================
      // SEND TO PUTER
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

      // ========================================================
      // STREAMING
      // ========================================================

      if (requestBody.stream) {

        res.status(
          upstream.status
        );

        res.setHeader(
          "Content-Type",
          upstream.headers.get(
            "content-type"
          ) ||
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

            if (
              !res.writableEnded
            ) {

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

      let data;

      try {

        data =
          JSON.parse(text);

      } catch {

        data = {
          error: {
            message:
              text ||
              "Invalid response from Puter",

            type:
              "upstream_error",

            code:
              upstream.status
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
        error.message
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
      "[PROXY] Puter OpenAI-compatible proxy is running"
    );

    console.log(
      `[PROXY] Port: ${PORT}`
    );

    console.log(
      `[PROXY] Provider: Puter`
    );

    console.log(
      `[PROXY] Streaming: ENABLED`
    );

    console.log(
      `[PROXY] Model: PASSTHROUGH`
    );

    console.log(
      "================================================"
    );
  }
);
