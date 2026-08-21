// server.js — Kimi K2.6 OpenAI-compatible proxy
// NVIDIA NIM + Render
// 256K context / 65,536 max output
// Thinking + Streaming
// OpenAI-compatible

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { StringDecoder } = require('string_decoder');
const { timingSafeEqual } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIG
// ============================================================

const NIM_API_BASE =
  process.env.NIM_API_BASE ||
  'https://integrate.api.nvidia.com/v1';

const NIM_API_KEY = process.env.NIM_API_KEY;
const CLIENT_AUTH_KEY = process.env.CLIENT_AUTH_KEY;

const ENABLE_THINKING_MODE =
  process.env.ENABLE_THINKING_MODE === 'true';

const SHOW_REASONING =
  process.env.SHOW_REASONING === 'true';

const SKIP_VALIDATION =
  process.env.SKIP_VALIDATION === 'true';

const DISCORD_WEBHOOK_URL =
  process.env.DISCORD_WEBHOOK_URL;

// Kimi K2.6:
// Context: 256K
// Maximum generated output: 65,536
const MAX_TOKENS_LIMIT = 65536;

const REQUEST_TIMEOUT_MS = 180000;
const VALIDATION_TIMEOUT_MS = 15000;
const MAX_BUFFER_SIZE = 1024 * 1024;

const KIMI_MODEL = 'moonshotai/kimi-k2.6';

console.log(
  `[CONFIG] Model: ${KIMI_MODEL}`
);

console.log(
  `[CONFIG] Thinking: ${
    ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'
  }`
);

console.log(
  `[CONFIG] Show reasoning: ${
    SHOW_REASONING ? 'ENABLED' : 'DISABLED'
  }`
);

// ============================================================
// CONFIG VALIDATION
// ============================================================

function validateConfig() {
  const fatal = (message) => {
    console.error(`[FATAL] ${message}`);
    process.exit(1);
  };

  if (!NIM_API_KEY) {
    fatal(
      'NIM_API_KEY is missing.'
    );
  }

  if (!CLIENT_AUTH_KEY) {
    console.warn(
      '[WARN] CLIENT_AUTH_KEY is not set.'
    );
  }
}

validateConfig();

// ============================================================
// MODEL MAPPING
// ============================================================

// Janitor can request whatever model name it wants.
// The proxy ALWAYS sends Kimi K2.6 upstream.

const MODEL_MAPPING = {
  'kimi-k2.6': KIMI_MODEL,

  // Common OpenAI-compatible aliases
  'gpt-4-turbo': KIMI_MODEL,
  'gpt-4': KIMI_MODEL,
  'gpt-4o': KIMI_MODEL,
  'gpt-3.5-turbo': KIMI_MODEL,
  'claude-3-opus': KIMI_MODEL,
  'claude-3-sonnet': KIMI_MODEL
};

// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: '10mb'
  })
);

// ============================================================
// AUTH
// ============================================================

function extractBearerToken(authHeader) {
  if (
    !authHeader ||
    typeof authHeader !== 'string'
  ) {
    return null;
  }

  const parts =
    authHeader.trim().split(/\s+/);

  if (
    parts.length !== 2 ||
    parts[0] !== 'Bearer'
  ) {
    return null;
  }

  return parts[1];
}

function safeTimingEqual(a, b) {
  if (
    !a ||
    !b ||
    a.length !== b.length
  ) {
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

  const token =
    extractBearerToken(
      req.headers.authorization
    );

  if (
    !token ||
    !CLIENT_AUTH_KEY
  ) {
    return res.status(403).json({
      error: {
        message:
          'Forbidden: Invalid or missing authentication',
        type:
          'authentication_error',
        code: 403
      }
    });
  }

  if (
    !safeTimingEqual(
      token,
      CLIENT_AUTH_KEY
    )
  ) {
    return res.status(403).json({
      error: {
        message:
          'Forbidden: Invalid authentication credentials',
        type:
          'authentication_error',
        code: 403
      }
    });
  }

  next();
});

// ============================================================
// NVIDIA MODEL VALIDATION
// ============================================================

async function validateModels() {

  if (SKIP_VALIDATION) {
    console.log(
      '[VALIDATION] Skipped.'
    );
    return;
  }

  console.log(
    '[VALIDATION] Checking Kimi K2.6...'
  );

  try {

    const response =
      await axios.get(
        `${NIM_API_BASE}/models`,
        {
          headers: {
            Authorization:
              `Bearer ${NIM_API_KEY}`,
            Accept:
              'application/json'
          },

          timeout:
            VALIDATION_TIMEOUT_MS
        }
      );

    const models =
      response.data?.data || [];

    const found =
      models.some(
        model =>
          model.id === KIMI_MODEL
      );

    if (found) {

      console.log(
        `[VALIDATION] ✓ ${KIMI_MODEL}`
      );

    } else {

      console.warn(
        `[VALIDATION] Kimi was not returned by /models.`
      );

      console.warn(
        `[VALIDATION] This does NOT automatically mean inference is unavailable.`
      );
    }

  } catch (error) {

    console.warn(
      `[VALIDATION] /models check failed: ${error.message}`
    );

    console.warn(
      '[VALIDATION] Continuing — inference endpoint is the actual test.'
    );
  }
}

// ============================================================
// SAFE STREAM WRITE
// ============================================================

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

  } catch (error) {

    console.warn(
      '[STREAM] Write failed:',
      error.message
    );
  }

  return false;
}

// ============================================================
// NVIDIA KIMI REQUEST
// ============================================================

async function callKimi(requestBody) {

  return axios.post(

    `${NIM_API_BASE}/chat/completions`,

    requestBody,

    {
      headers: {
        Authorization:
          `Bearer ${NIM_API_KEY}`,

        'Content-Type':
          'application/json',

        Accept:
          requestBody.stream
            ? 'text/event-stream'
            : 'application/json'
      },

      responseType:
        requestBody.stream
          ? 'stream'
          : 'json',

      timeout:
        REQUEST_TIMEOUT_MS,

      // Important:
      // allow us to inspect NVIDIA's actual response
      validateStatus:
        status => status >= 200 && status < 300
    }
  );
}

// ============================================================
// HEALTH
// ============================================================

app.get(
  '/health',
  (req, res) => {

    res.json({
      status: 'ok',

      model:
        KIMI_MODEL,

      thinking:
        ENABLE_THINKING_MODE,

      context_window:
        262144,

      max_output_tokens:
        MAX_TOKENS_LIMIT,

      version:
        '4.0.0'
    });
  }
);

// ============================================================
// MODELS
// ============================================================

app.get(
  '/v1/models',
  (req, res) => {

    const now =
      Math.floor(
        Date.now() / 1000
      );

    res.json({
      object: 'list',

      data: [
        {
          id: 'kimi-k2.6',
          object: 'model',
          created: now,
          owned_by: 'moonshotai'
        },

        // Janitor/OpenAI compatibility
        {
          id: 'gpt-4-turbo',
          object: 'model',
          created: now,
          owned_by: 'nim-proxy'
        },

        {
          id: 'gpt-4',
          object: 'model',
          created: now,
          owned_by: 'nim-proxy'
        },

        {
          id: 'gpt-4o',
          object: 'model',
          created: now,
          owned_by: 'nim-proxy'
        },

        {
          id: 'gpt-3.5-turbo',
          object: 'model',
          created: now,
          owned_by: 'nim-proxy'
        }
      ]
    });
  }
);

// ============================================================
// CHAT COMPLETIONS
// ============================================================

app.post(
  '/v1/chat/completions',
  async (req, res) => {

    let upstreamStream = null;
    let streamEndedCleanly = false;

    try {

      const {
        model,
        messages,
        temperature,
        max_tokens,
        stream,
        top_p,
        tools,
        tool_choice,
        seed,
        stream_options,
        stop
      } = req.body;

      // --------------------------------------------------------
      // Validate messages
      // --------------------------------------------------------

      if (
        !Array.isArray(messages) ||
        messages.length === 0
      ) {

        return res.status(400).json({
          error: {
            message:
              'messages must be a non-empty array',

            type:
              'invalid_request_error',

            code: 400
          }
        });
      }

      // --------------------------------------------------------
      // Temperature
      // Kimi K2.6 supports 0–1
      // --------------------------------------------------------

      let safeTemperature = 0.7;

      if (
        temperature !== undefined &&
        Number.isFinite(
          Number(temperature)
        )
      ) {

        safeTemperature =
          Math.max(
            0,
            Math.min(
              Number(temperature),
              1
            )
          );
      }

      // --------------------------------------------------------
      // max_tokens
      // Maximum = 65,536
      // --------------------------------------------------------

      let requestedMaxTokens =
        8192;

      if (
        max_tokens !== undefined &&
        Number.isFinite(
          Number(max_tokens)
        )
      ) {

        requestedMaxTokens =
          Number(max_tokens);
      }

      const safeMaxTokens =
        Math.max(
          1,
          Math.min(
            requestedMaxTokens,
            MAX_TOKENS_LIMIT
          )
        );

      // --------------------------------------------------------
      // STREAM
      // --------------------------------------------------------

      const useStream =
        Boolean(stream);

      // --------------------------------------------------------
      // Build NVIDIA request
      // --------------------------------------------------------

      const baseRequest = {

        model:
          KIMI_MODEL,

        messages,

        temperature:
          safeTemperature,

        max_tokens:
          safeMaxTokens,

        stream:
          useStream
      };

      // --------------------------------------------------------
      // Optional parameters
      // --------------------------------------------------------

      if (
        top_p !== undefined
      ) {
        baseRequest.top_p =
          top_p;
      }

      if (
        tools !== undefined
      ) {
        baseRequest.tools =
          tools;
      }

      if (
        tool_choice !== undefined
      ) {
        baseRequest.tool_choice =
          tool_choice;
      }

      if (
        seed !== undefined
      ) {
        baseRequest.seed =
          seed;
      }

      if (
        stream_options !== undefined
      ) {
        baseRequest.stream_options =
          stream_options;
      }

      if (
        stop !== undefined
      ) {
        baseRequest.stop =
          stop;
      }

      // --------------------------------------------------------
      // THINKING
      //
      // NVIDIA K2.6 officially supports:
      // chat_template_kwargs: { thinking: true/false }
      // --------------------------------------------------------

      baseRequest.chat_template_kwargs = {
        thinking:
          ENABLE_THINKING_MODE
      };

      console.log(
        `[KIMI] model=${KIMI_MODEL} ` +
        `temperature=${safeTemperature} ` +
        `max_tokens=${safeMaxTokens} ` +
        `stream=${useStream} ` +
        `thinking=${ENABLE_THINKING_MODE}`
      );

      // --------------------------------------------------------
      // CALL NVIDIA
      // --------------------------------------------------------

      let response;

      try {

        response =
          await callKimi(
            baseRequest
          );

      } catch (error) {

        // ======================================================
        // VERY IMPORTANT:
        // Print the REAL NVIDIA error.
        // ======================================================

        console.error(
          '================================================'
        );

        console.error(
          '[NVIDIA ERROR]'
        );

        console.error(
          'Status:',
          error.response?.status
        );

        console.error(
          'Status text:',
          error.response?.statusText
        );

        console.error(
          'Headers:',
          JSON.stringify(
            error.response?.headers || {},
            null,
            2
          )
        );

        console.error(
          'Data:',
          JSON.stringify(
            error.response?.data || {},
            null,
            2
          )
        );

        console.error(
          'Request URL:',
          `${NIM_API_BASE}/chat/completions`
        );

        console.error(
          'Model:',
          KIMI_MODEL
        );

        console.error(
          '================================================'
        );

        throw error;
      }

      upstreamStream =
        response.data;

      console.log(
        '[KIMI] NVIDIA response received.'
      );

      // ========================================================
      // STREAMING
      // ========================================================

      if (useStream) {

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

        let reasoningOpen =
          false;

        let doneSent =
          false;

        let cleanedUp =
          false;

        const cleanup = () => {

          if (cleanedUp) {
            return;
          }

          cleanedUp = true;

          if (upstreamStream) {
            upstreamStream.removeAllListeners();
          }

          req.removeAllListeners(
            'close'
          );
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

        const processLine =
          (line) => {

            if (
              !line.startsWith(
                'data: '
              )
            ) {
              return;
            }

            const payload =
              line
                .slice(6)
                .trim();

            if (
              payload ===
              '[DONE]'
            ) {

              sendDone();

              streamEndedCleanly =
                true;

              return;
            }

            try {

              const data =
                JSON.parse(
                  payload
                );

              const delta =
                data
                  .choices?.[0]
                  ?.delta;

              if (delta) {

                const reasoning =
                  delta.reasoning_content;

                const content =
                  delta.content;

                // ------------------------------------------------
                // SHOW_REASONING=true
                // ------------------------------------------------

                if (
                  SHOW_REASONING
                ) {

                  if (
                    reasoning &&
                    !reasoningOpen
                  ) {

                    delta.content =
                      `<thinking>\n${reasoning}`;

                    reasoningOpen =
                      true;

                  } else if (
                    reasoning
                  ) {

                    delta.content =
                      reasoning;

                  } else if (
                    content &&
                    reasoningOpen
                  ) {

                    delta.content =
                      `\n</thinking>\n\n${content}`;

                    reasoningOpen =
                      false;

                  } else {

                    delta.content =
                      content || '';
                  }

                } else {

                  // Never expose hidden reasoning
                  delete delta.reasoning_content;
                }
              }

              safeWrite(
                res,
                `data: ${JSON.stringify(data)}\n\n`
              );

            } catch (error) {

              console.warn(
                '[STREAM] Invalid JSON chunk:',
                error.message
              );
            }
          };

        upstreamStream.on(
          'data',
          chunk => {

            buffer +=
              decoder.write(
                chunk
              );

            if (
              buffer.length >
              MAX_BUFFER_SIZE
            ) {

              console.error(
                '[STREAM] Buffer overflow.'
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

              processLine(
                line
              );
            }
          }
        );

        upstreamStream.on(
          'end',
          () => {

            buffer +=
              decoder.end();

            if (
              buffer.trim()
            ) {

              for (
                const line
                of buffer.split('\n')
              ) {

                processLine(
                  line
                );
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
          error => {

            console.error(
              '[STREAM] NVIDIA stream error:',
              error.message
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
                '[STREAM] Client disconnected.'
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

      // ========================================================
      // NON-STREAMING
      // ========================================================

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
                  `<thinking>\n` +
                  `${message.reasoning_content}` +
                  `\n</thinking>\n\n` +
                  content;
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
          model ||
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

      // ========================================================
      // FINAL ERROR HANDLER
      // ========================================================

      console.error(
        '[PROXY] Request failed:',
        error.message
      );

      const status =
        error.response?.status ||
        500;

      let upstreamData =
        error.response?.data;

      // Axios may give us a stream for streamed errors.
      // Try to extract it if necessary.
      if (
        upstreamData &&
        typeof upstreamData !== 'object'
      ) {
        try {
          upstreamData =
            JSON.parse(
              String(upstreamData)
            );
        } catch {
          // Keep raw data
        }
      }

      let message =
        upstreamData?.error?.message ||
        upstreamData?.message ||
        error.message ||
        'Kimi request failed';

      console.error(
        `[PROXY] Returning status ${status}`
      );

      console.error(
        '[PROXY] NVIDIA response:',
        JSON.stringify(
          upstreamData || {},
          null,
          2
        )
      );

      if (
        !res.headersSent
      ) {

        res.status(status).json({

          error: {

            message,

            type:
              'proxy_error',

            code:
              status,

            upstream:
              'nvidia',

            model:
              KIMI_MODEL
          }
        });

      } else if (
        !res.writableEnded
      ) {

        safeWrite(
          res,
          `data: ${JSON.stringify({
            error: {
              message,
              type:
                'proxy_error',
              code:
                status
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
          'invalid_request_error',

        code: 404
      }
    });
  }
);

// ============================================================
// START SERVER
// ============================================================

app.listen(
  PORT,
  () => {

    console.log(
      '================================================'
    );

    console.log(
      '[PROXY] Kimi K2.6 proxy is running.'
    );

    console.log(
      `[PROXY] Port: ${PORT}`
    );

    console.log(
      `[PROXY] Model: ${KIMI_MODEL}`
    );

    console.log(
      '[PROXY] Context: 256K'
    );

    console.log(
      `[PROXY] Max output: ${MAX_TOKENS_LIMIT}`
    );

    console.log(
      `[PROXY] Thinking: ${
        ENABLE_THINKING_MODE
          ? 'ON'
          : 'OFF'
      }`
    );

    console.log(
      '================================================'
    );

    validateModels()
      .catch(
        error => {

          console.error(
            '[VALIDATION] Startup error:',
            error.message
          );
        }
      );
  }
);
