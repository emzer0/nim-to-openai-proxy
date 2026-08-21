// server.js — Kimi K2.6 OpenAI-compatible proxy
// NVIDIA NIM + Render
// Thinking ON
// Streaming supported

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const { timingSafeEqual } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────

const NIM_API_BASE =
  process.env.NIM_API_BASE ||
  'https://integrate.api.nvidia.com/v1';

const NIM_API_KEY = process.env.NIM_API_KEY;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY;

// Thinking is intentionally controlled by Render Environment Variables.
// Set ENABLE_THINKING_MODE=true
const ENABLE_THINKING_MODE =
  process.env.ENABLE_THINKING_MODE === 'true';

const SHOW_REASONING =
  process.env.SHOW_REASONING === 'true';

const SKIP_VALIDATION =
  process.env.SKIP_VALIDATION === 'true';

const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL;

// NVIDIA Kimi K2.6 API limit.
// IMPORTANT: this is OUTPUT max_tokens, not context length.
const MAX_TOKENS_LIMIT = 65536;

const REQUEST_TIMEOUT_MS = 180000;
const VALIDATION_TIMEOUT_MS = 15000;
const MAX_BUFFER_SIZE = 1024 * 1024;

const KIMI_MODEL = 'moonshotai/kimi-k2.6';

if (ENABLE_THINKING_MODE) {
  console.log('[CONFIG] Thinking mode: ENABLED');
} else {
  console.log('[CONFIG] Thinking mode: DISABLED');
}

if (SHOW_REASONING) {
  console.log('[CONFIG] Reasoning display: ENABLED');
}

// ─────────────────────────────────────────────────────────────
// VALIDATE CONFIG
// ─────────────────────────────────────────────────────────────

function validateConfig() {
  const fatal = (msg) => {
    console.error(`[FATAL] ${msg}`);
    process.exit(1);
  };

  if (!NIM_API_KEY) {
    fatal(
      'NIM_API_KEY is required. Get one at https://build.nvidia.com/'
    );
  }

  if (!CLIENT_AUTH_KEY) {
    console.warn(
      '[WARN] CLIENT_AUTH_KEY not set. Protected requests will return 403.'
    );
  }
}

validateConfig();

// ─────────────────────────────────────────────────────────────
// MODEL MAPPING
// ─────────────────────────────────────────────────────────────

// Everything intentionally points to Kimi K2.6.
// This prevents the proxy from silently switching models.

const MODEL_MAPPING = {
  'kimi-k2.6': KIMI_MODEL,
  'gpt-4-turbo': KIMI_MODEL
};

// No fallback models.
// If Kimi fails, we want the actual Kimi error instead of
// silently switching to another model.

const FALLBACK_MODELS = [];

// ─────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────

app.use(cors());

app.use(
  express.json({
    limit: '10mb'
  })
);

// ─────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────

function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }

  const parts = authHeader.trim().split(/\s+/);

  if (parts.length !== 2) {
    return null;
  }

  if (parts[0] !== 'Bearer') {
    return null;
  }

  return parts[1];
}

function safeTimingEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  try {
    return timingSafeEqual(
      Buffer.from(a),
      Buffer.from(b)
    );
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  // Public endpoints
  if (
    req.path === '/health' ||
    req.path === '/v1/models'
  ) {
    return next();
  }

  const token = extractBearerToken(
    req.headers.authorization
  );

  if (!token || !CLIENT_AUTH_KEY) {
    return res.status(403).json({
      error: {
        message: 'Forbidden: Invalid or missing authentication',
        type: 'authentication_error',
        code: 403
      }
    });
  }

  if (!safeTimingEqual(token, CLIENT_AUTH_KEY)) {
    return res.status(403).json({
      error: {
        message: 'Forbidden: Invalid authentication credentials',
        type: 'authentication_error',
        code: 403
      }
    });
  }

  next();
});

// ─────────────────────────────────────────────────────────────
// MODEL VALIDATION
// ─────────────────────────────────────────────────────────────

async function validateModels() {
  if (SKIP_VALIDATION) {
    console.log(
      '[VALIDATION] Skipped (SKIP_VALIDATION=true)'
    );
    return;
  }

  console.log(
    '[VALIDATION] Checking Kimi K2.6 availability via /v1/models...'
  );

  try {
    const response = await axios.get(
      `${NIM_API_BASE}/models`,
      {
        headers: {
          Authorization: `Bearer ${NIM_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: VALIDATION_TIMEOUT_MS
      }
    );

    const availableModels = new Set(
      (response.data.data || []).map(
        (model) => model.id
      )
    );

    if (availableModels.has(KIMI_MODEL)) {
      console.log(
        `[VALIDATION] ✓ kimi-k2.6 → ${KIMI_MODEL}`
      );

      console.log(
        `[VALIDATION] ✓ gpt-4-turbo → ${KIMI_MODEL}`
      );
    } else {
      console.warn(
        `[VALIDATION] ✗ ${KIMI_MODEL} not found in NIM catalog`
      );
    }

  } catch (err) {
    console.warn(
      `[VALIDATION] /v1/models failed: ${err.message}`
    );

    console.warn(
      '[VALIDATION] Continuing anyway because the inference endpoint is the real test.'
    );
  }
}

// ─────────────────────────────────────────────────────────────
// SAFE STREAM WRITE
// ─────────────────────────────────────────────────────────────

function safeWrite(res, data) {
  try {
    if (
      !res.writableEnded &&
      !res.destroyed &&
      res.writable
    ) {
      res.write(data);
      return true;
    }
  } catch (err) {
    console.warn(
      '[STREAM] Write failed:',
      err.message
    );
  }

  return false;
}

// ─────────────────────────────────────────────────────────────
// KIMI REQUEST
// ─────────────────────────────────────────────────────────────

async function callKimi(baseRequest) {
  return axios.post(
    `${NIM_API_BASE}/chat/completions`,
    {
      ...baseRequest,
      model: KIMI_MODEL
    },
    {
      headers: {
        Authorization: `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: baseRequest.stream
          ? 'text/event-stream'
          : 'application/json'
      },

      responseType: baseRequest.stream
        ? 'stream'
        : 'json',

      timeout: REQUEST_TIMEOUT_MS
    }
  );
}

// ─────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: KIMI_MODEL,
    thinking: ENABLE_THINKING_MODE,
    max_output_tokens: MAX_TOKENS_LIMIT,
    version: '3.0.0'
  });
});

// ─────────────────────────────────────────────────────────────
// MODELS
// ─────────────────────────────────────────────────────────────

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',

    data: [
      {
        id: 'kimi-k2.6',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'moonshotai'
      },

      {
        id: 'gpt-4-turbo',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'nim-proxy'
      }
    ]
  });
});

// ─────────────────────────────────────────────────────────────
// CHAT COMPLETIONS
// ─────────────────────────────────────────────────────────────

app.post(
  '/v1/chat/completions',
  async (req, res) => {

    let upstreamStream = null;
    let streamEndedCleanly = false;

    try {

      const {
        messages,
        temperature,
        max_tokens,
        stream,
        top_p,
        tools,
        tool_choice,
        seed,
        stream_options
      } = req.body;

      if (
        !Array.isArray(messages) ||
        messages.length === 0
      ) {
        return res.status(400).json({
          error: {
            message: 'messages must be a non-empty array',
            type: 'invalid_request_error',
            code: 400
          }
        });
      }

      // Kimi API supports temperature 0–1.
      const safeTemperature =
        temperature === undefined
          ? 0.7
          : Math.max(
              0,
              Math.min(
                Number(temperature),
                1
              )
            );

      // IMPORTANT:
      // 65536 is the maximum OUTPUT token value accepted
      // by Kimi K2.6.
      const requestedMaxTokens =
        max_tokens === undefined
          ? 8192
          : Number(max_tokens);

      const safeMaxTokens = Math.max(
        1,
        Math.min(
          requestedMaxTokens,
          MAX_TOKENS_LIMIT
        )
      );

      // ───────────────────────────────────────────────
      // BASE REQUEST
      // ───────────────────────────────────────────────

      const baseRequest = {
        messages,

        temperature: safeTemperature,

        max_tokens: safeMaxTokens,

        stream: Boolean(stream)
      };

      // Preserve optional OpenAI-compatible parameters.

      if (top_p !== undefined) {
        baseRequest.top_p = top_p;
      }

      if (tools !== undefined) {
        baseRequest.tools = tools;
      }

      if (tool_choice !== undefined) {
        baseRequest.tool_choice = tool_choice;
      }

      if (seed !== undefined) {
        baseRequest.seed = seed;
      }

      if (stream_options !== undefined) {
        baseRequest.stream_options =
          stream_options;
      }

      // ───────────────────────────────────────────────
      // THINKING
      // ───────────────────────────────────────────────

      if (ENABLE_THINKING_MODE) {

        baseRequest.chat_template_kwargs = {
          thinking: true
        };

        console.log(
          '[KIMI] Thinking: ON'
        );

      } else {

        baseRequest.chat_template_kwargs = {
          thinking: false
        };

        console.log(
          '[KIMI] Thinking: OFF'
        );
      }

      console.log(
        `[KIMI] Request | max_tokens=${safeMaxTokens} | stream=${Boolean(stream)}`
      );

      // ───────────────────────────────────────────────
      // CALL NVIDIA
      // ───────────────────────────────────────────────

      const response =
        await callKimi(baseRequest);

      upstreamStream = response.data;

      console.log(
        `[KIMI] NVIDIA response received`
      );

      // ───────────────────────────────────────────────
      // STREAMING
      // ───────────────────────────────────────────────

      if (stream) {

        res.statusCode = 200;

        res.setHeader(
          'Content-Type',
          'text/event-stream'
        );

        res.setHeader(
          'Cache-Control',
          'no-cache, no-transform'
        );

        res.setHeader(
          'Connection',
          'keep-alive'
        );

        res.setHeader(
          'X-Accel-Buffering',
          'no'
        );

        const decoder =
          new StringDecoder('utf8');

        let buffer = '';
        let reasoningOpen = false;
        let doneSent = false;
        let cleanedUp = false;

        const cleanup = () => {

          if (cleanedUp) {
            return;
          }

          cleanedUp = true;

          if (upstreamStream) {
            upstreamStream.removeAllListeners();
          }

          req.removeAllListeners('close');
        };

        const sendDone = () => {

          if (!doneSent) {

            safeWrite(
              res,
              'data: [DONE]\n\n'
            );

            doneSent = true;
          }
        };

        const processLine = (line) => {

          if (!line.startsWith('data: ')) {
            return;
          }

          const payload =
            line.slice(6).trim();

          if (payload === '[DONE]') {

            sendDone();

            streamEndedCleanly = true;

            return;
          }

          try {

            const data =
              JSON.parse(payload);

            const choice =
              data.choices?.[0];

            const delta =
              choice?.delta;

            if (delta) {

              const reasoning =
                delta.reasoning_content;

              const normalContent =
                delta.content;

              // ───────────────────────────────
              // Optional reasoning display
              // ───────────────────────────────

              if (SHOW_REASONING) {

                if (
                  reasoning &&
                  !reasoningOpen
                ) {

                  delta.content =
                    `<thinking>\n${reasoning}`;

                  reasoningOpen = true;

                } else if (
                  reasoning
                ) {

                  delta.content =
                    reasoning;

                } else if (
                  normalContent &&
                  reasoningOpen
                ) {

                  delta.content =
                    `\n</thinking>\n\n${normalContent}`;

                  reasoningOpen = false;

                } else {

                  delta.content =
                    normalContent || '';
                }

              }

              // Don't leak reasoning_content
              // unless SHOW_REASONING is enabled.

              if (!SHOW_REASONING) {
                delete delta.reasoning_content;
              }
            }

            safeWrite(
              res,
              `data: ${JSON.stringify(data)}\n\n`
            );

          } catch (err) {

            console.warn(
              '[STREAM] Invalid JSON chunk:',
              err.message
            );
          }
        };

        upstreamStream.on(
          'data',
          (chunk) => {

            buffer +=
              decoder.write(chunk);

            if (
              buffer.length >
              MAX_BUFFER_SIZE
            ) {

              console.error(
                '[STREAM] Buffer overflow'
              );

              safeWrite(
                res,
                `data: ${JSON.stringify({
                  error: {
                    message:
                      'Stream buffer overflow',
                    type:
                      'stream_error'
                  }
                })}\n\n`
              );

              sendDone();

              if (
                !res.writableEnded
              ) {
                res.end();
              }

              upstreamStream.destroy();

              cleanup();

              return;
            }

            const lines =
              buffer.split('\n');

            buffer =
              lines.pop() || '';

            for (
              const line of lines
            ) {
              processLine(line);
            }
          }
        );

        upstreamStream.on(
          'end',
          () => {

            buffer +=
              decoder.end();

            if (buffer.trim()) {

              for (
                const line
                of buffer.split('\n')
              ) {
                processLine(line);
              }
            }

            sendDone();

            streamEndedCleanly =
              true;

            if (
              !res.writableEnded
            ) {
              res.end();
            }

            cleanup();
          }
        );

        upstreamStream.on(
          'error',
          (err) => {

            console.error(
              '[STREAM] NVIDIA error:',
              err.message
            );

            if (
              !res.writableEnded
            ) {

              safeWrite(
                res,
                `data: ${JSON.stringify({
                  error: {
                    message:
                      'NVIDIA Kimi stream interrupted',
                    type:
                      'stream_error'
                  }
                })}\n\n`
              );

              sendDone();

              res.end();
            }

            cleanup();
          }
        );

        req.on(
          'close',
          () => {

            const clientGone =
              req.destroyed ||
              !res.writable;

            if (
              clientGone &&
              !streamEndedCleanly
            ) {

              console.warn(
                '[STREAM] Client disconnected'
              );
            }

            if (
              upstreamStream &&
              !upstreamStream.destroyed &&
              !streamEndedCleanly
            ) {

              upstreamStream.destroy();
            }

            cleanup();
          }
        );

        return;
      }

      // ───────────────────────────────────────────────
      // NON-STREAMING
      // ───────────────────────────────────────────────

      const data =
        response.data;

      const choices =
        (data.choices || [])
          .map(
            (choice, index) => {

              const message =
                choice.message || {};

              let content =
                message.content || '';

              if (
                SHOW_REASONING &&
                message.reasoning_content
              ) {

                content =
                  `<thinking>\n${message.reasoning_content}\n</thinking>\n\n${content}`;
              }

              return {
                index,

                message: {
                  role:
                    message.role ||
                    'assistant',

                  content,

                  tool_calls:
                    message.tool_calls
                },

                finish_reason:
                  choice.finish_reason ||
                  'stop'
              };
            }
          );

      res.json({
        id:
          data.id ||
          `chatcmpl-${Date.now()}`,

        object:
          'chat.completion',

        created:
          data.created ||
          Math.floor(
            Date.now() / 1000
          ),

        model:
          'kimi-k2.6',

        choices,

        usage:
          data.usage || {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
          }
      });

    } catch (error) {

      console.error(
        '[PROXY] Request failed:',
        error.message
      );

      if (error.response) {

        console.error(
          '[PROXY] NVIDIA status:',
          error.response.status
        );

        console.error(
          '[PROXY] NVIDIA data:',
          error.response.data
        );
      }

      if (!res.headersSent) {

        let message =
          error.message ||
          'Kimi request failed';

        let status =
          error.response?.status ||
          500;

        let upstreamData =
          error.response?.data;

        if (
          upstreamData &&
          typeof upstreamData === 'object' &&
          upstreamData.error?.message
        ) {

          message =
            upstreamData.error.message;
        }

        res.status(status).json({
          error: {
            message,
            type:
              'proxy_error',
            code:
              status
          }
        });

      } else if (
        !res.writableEnded
      ) {

        safeWrite(
          res,
          `data: ${JSON.stringify({
            error: {
              message:
                error.message ||
                'Proxy error',
              type:
                'proxy_error'
            }
          })}\n\n`
        );

        safeWrite(
          res,
          'data: [DONE]\n\n'
        );

        res.end();
      }

      if (
        upstreamStream &&
        !upstreamStream.destroyed
      ) {

        upstreamStream.destroy();
      }
    }
  }
);

// ─────────────────────────────────────────────────────────────
// 404
// ─────────────────────────────────────────────────────────────

app.use(
  (req, res) => {

    res.status(404).json({
      error: {
        message:
          `Endpoint ${req.method} ${req.path} not found`,
        type:
          'invalid_request_error',
        code:
          404
      }
    });
  }
);

// ─────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────

app.listen(
  PORT,
  () => {

    console.log(
      `[PROXY] Kimi K2.6 proxy running on port ${PORT}`
    );

    console.log(
      `[PROXY] Model: ${KIMI_MODEL}`
    );

    console.log(
      `[PROXY] Max output tokens: ${MAX_TOKENS_LIMIT}`
    );

    console.log(
      `[PROXY] Thinking: ${ENABLE_THINKING_MODE ? 'ON' : 'OFF'}`
    );

    validateModels()
      .catch(
        (err) => {

          console.error(
            '[VALIDATION] Startup check failed:',
            err.message
          );
        }
      );
  }
);
