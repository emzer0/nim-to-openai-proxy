// server.js
// Render -> Puter -> OpenAI-compatible API
// GLM / Kimi / други Puter модели
// Streaming + OpenAI-compatible
// Version 7.0.0

const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 10000;

const PUTER_AUTH_TOKEN = process.env.PUTER_AUTH_TOKEN;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY || "";

// Official Puter OpenAI-compatible endpoint
const PUTER_BASE_URL =
  "https://api.puter.com/puterai/openai/v1";

// ------------------------------------------------------------
// CONFIG
// ------------------------------------------------------------

if (!PUTER_AUTH_TOKEN) {
  console.error("[FATAL] PUTER_AUTH_TOKEN is missing.");
  process.exit(1);
}

console.log("================================================");
console.log("[PROXY] Puter OpenAI-compatible proxy");
console.log(`[PROXY] Port: ${PORT}`);
console.log("[PROXY] Provider: Puter");
console.log("[PROXY] Streaming: ENABLED");
console.log("[PROXY] Model: PASSTHROUGH");
console.log("================================================");

app.use(cors());

app.use(
  express.json({
    limit: "20mb"
  })
);

// ------------------------------------------------------------
// AUTH
// ------------------------------------------------------------

function authenticate(req, res, next) {

  // Public endpoints
  if (
    req.path === "/" ||
    req.path === "/health" ||
    req.path === "/v1/models"
  ) {
    return next();
  }

  // No client key configured = allow requests
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

// ------------------------------------------------------------
// ROOT
// ------------------------------------------------------------

app.get("/", (req, res) => {

  res.json({
    status: "ok",
    service: "Puter OpenAI-compatible proxy",
    provider: "puter",
    version: "7.0.0"
  });
});

// ------------------------------------------------------------
// HEALTH
// ------------------------------------------------------------

app.get("/health", (req, res) => {

  res.json({
    status: "ok",
    provider: "puter",
    streaming: true,
    openai_compatible: true,
    version: "7.0.0"
  });
});

// ------------------------------------------------------------
// MODELS
//
// IMPORTANT:
// We do NOT ask Puter for /models.
// The previous implementation did that and Puter returned 404.
//
// Instead we expose a local OpenAI-compatible model list.
// Actual requests are passed through to Puter.
// ------------------------------------------------------------

app.get("/v1/models", (req, res) => {

  const now =
    Math.floor(Date.now() / 1000);

  res.json({
    object: "list",

    data: [

      {
        id: "z-ai/glm-5.2",
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
        id: "openai/gpt-5.5",
        object: "model",
        created: now,
        owned_by: "puter"
      }

    ]
  });
});

// ------------------------------------------------------------
// CHAT COMPLETIONS
// ------------------------------------------------------------

app.post(
  "/v1/chat/completions",
  async (req, res) => {

    try {

      const body =
        req.body || {};

      // --------------------------------------------------------
      // Validate messages
      // --------------------------------------------------------

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

            code:
              400
          }
        });
      }

      // --------------------------------------------------------
      // Preserve the model exactly as Janitor sends it.
      // --------------------------------------------------------

      const requestBody = {
        ...body
      };

      // Remove proxy-only field if present
      delete requestBody.provider;

      // --------------------------------------------------------
      // Default model
      //
      // If Janitor does not provide one, use GLM 5.2.
      // --------------------------------------------------------

      if (
        !requestBody.model ||
        typeof requestBody.model !== "string"
      ) {

        requestBody.model =
          "z-ai/glm-5.2";
      }

      // --------------------------------------------------------
      // Normalize stream
      // --------------------------------------------------------

      if (
        requestBody.stream !== undefined
      ) {

        requestBody.stream =
          Boolean(requestBody.stream);

      } else {

        requestBody.stream =
          false;
      }

      console.log(
        `[REQUEST] model=${requestBody.model} ` +
        `stream=${requestBody.stream} ` +
        `messages=${requestBody.messages.length}`
      );

      // --------------------------------------------------------
      // Send request to Puter
      // --------------------------------------------------------

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
              !res.writableEnded &&
              !res.destroyed
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

        console.error(
          "[PUTER] Invalid JSON:",
          text
        );

        return res.status(
          upstream.ok
            ? 502
            : upstream.status
        ).json({
          error: {
            message:
              text ||
              "Puter returned invalid JSON",

            type:
              "upstream_error",

            code:
              upstream.ok
                ? 502
                : upstream.status,

            upstream:
              "puter"
          }
        });
      }

      // --------------------------------------------------------
      // Upstream error
      // --------------------------------------------------------

      if (!upstream.ok) {

        console.error(
          `[PUTER ERROR] HTTP ${upstream.status}`
        );

        console.error(
          JSON.stringify(
            data
          )
        );

        return res
          .status(upstream.status)
          .json({

            error: {

              message:
                data?.error?.message ||
                data?.message ||
                `Puter returned HTTP ${upstream.status}`,

              type:
                data?.error?.type ||
                "upstream_error",

              code:
                upstream.status,

              upstream:
                "puter",

              model:
                requestBody.model
            }

          });
      }

      // --------------------------------------------------------
      // Success
      // --------------------------------------------------------

      return res.json(data);

    } catch (error) {

      console.error(
        "[PROXY ERROR]",
        error.message
      );

      if (
        error.stack
      ) {

        console.error(
          error.stack
        );
      }

      if (
        !res.headersSent
      ) {

        return res.status(500).json({

          error: {

            message:
              error.message ||
              "Proxy request failed",

            type:
              "proxy_error",

            code:
              500,

            upstream:
              "puter"
          }

        });
      }

      if (
        !res.writableEnded
      ) {

        res.end();
      }
    }
  }
);

// ------------------------------------------------------------
// 404
// ------------------------------------------------------------

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

// ------------------------------------------------------------
// START
// ------------------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      "================================================"
    );

    console.log(
      "[PROXY] Puter proxy is running."
    );

    console.log(
      `[PROXY] Port: ${PORT}`
    );

    console.log(
      "[PROXY] OpenAI-compatible: YES"
    );

    console.log(
      "[PROXY] Streaming: YES"
    );

    console.log(
      "[PROXY] Default model: z-ai/glm-5.2"
    );

    console.log(
      "================================================"
    );
  }
);
