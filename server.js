// server.js — Kimi K2.6 OpenAI-compatible proxy
// NVIDIA NIM + Render
// Thinking ON
// Streaming supported
// Janitor-compatible
//
// Supports:
// POST /v1
// POST /v1/
// POST /v1/chat/completions
//
// Model:
// moonshotai/kimi-k2.6
//
// Context: 256K
// Max output: 65536
//
// IMPORTANT:
// Never stringify the complete Axios error object.
// Axios/Node HTTP objects contain circular references.

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

// Thinking is ON unless explicitly disabled.
const ENABLE_THINKING_MODE =
  process.env.ENABLE_THINKING_MODE !== 'false';

const SHOW_REASONING =
  process.env.SHOW_REASONING === 'true';

const SKIP_VALIDATION =
  process.env.SKIP_VALIDATION === 'true';

const KIMI_MODEL =
  'moonshotai/kimi-k2.6';

// Kimi K2.6 context.
const CONTEXT_LENGTH = 262144;

// Maximum OUTPUT tokens.
// This is NOT the context window.
const MAX_TOKENS_LIMIT = 65536;

const REQUEST_TIMEOUT_MS = 180000;
const VALIDATION_TIMEOUT_MS = 15000;

const MAX_BODY_SIZE = '20mb';
const MAX_BUFFER_SIZE = 2 * 1024 * 1024;


// ============================================================
// STARTUP LOG
// ============================================================

console.log(
  `[CONFIG] Model: ${KIMI_MODEL}`
);

console.log(
  `[CONFIG] Thinking: ${
    ENABLE_THINKING_MODE
      ? 'ENABLED'
      : 'DISABLED'
  }`
);

console.log(
  `[CONFIG] Show reasoning: ${
    SHOW_REASONING
      ? 'ENABLED'
      : 'DISABLED'
  }`
);

console.log(
  '================================================'
);

console.log(
  '[PROXY] Kimi K2.6 proxy is starting.'
);

console.log(
  `[PROXY] Port: ${PORT}`
);

console.log(
  `[PROXY] Model: ${KIMI_MODEL}`
);

console.log(
  `[PROXY] Context: ${
    CONTEXT_LENGTH / 1024
  }K`
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


// ============================================================
// CONFIG VALIDATION
// ============================================================

function validateConfig() {

  if (!NIM_API_KEY) {

    console.error(
      '[FATAL] NIM_API_KEY is missing.'
    );

    process.exit(1);
  }

  if (!CLIENT_AUTH_KEY) {

    console.warn(
      '[WARN] CLIENT_AUTH_KEY is not set.'
    );

    console.warn(
      '[WARN] Protected requests will return 403.'
    );
  }
}

validateConfig();


// ============================================================
// MIDDLEWARE
// ============================================================

app.use(cors());

app.use(
  express.json({
    limit: MAX_BODY_SIZE
  })
);


// ============================================================
// AUTH
// ============================================================

function extractBearerToken(
  authHeader
) {

  if (
    !authHeader ||
    typeof authHeader !== 'string'
  ) {
    return null;
  }

  const parts =
    authHeader
      .trim()
      .split(/\s+/);

  if (
    parts.length !== 2
  ) {
    return null;
  }

  if (
    parts[0].toLowerCase() !==
    'bearer'
  ) {
    return null;
  }

  return parts[1];
}


function safeTimingEqual(
  a,
  b
) {

  if (
    !a ||
    !b ||
    typeof a !== 'string' ||
    typeof b !== 'string'
  ) {
    return false;
  }

  const aa =
    Buffer.from(a);

  const bb =
    Buffer.from(b);

  if (
    aa.length !== bb.length
  ) {
    return false;
  }

  try {

    return timingSafeEqual(
      aa,
      bb
    );

  } catch {

    return false;
  }
}


app.use(
  (req, res, next) => {

    // Public endpoints.
    if (
      req.path === '/health' ||
      req.path === '/v1/models' ||
      req.path === '/models'
    ) {

      return next();
    }

    // Render health check.
    if (
      req.path === '/' &&
      req.method === 'GET'
    ) {

      return next();
    }

    const token =
      extractBearerToken(
        req.headers.authorization
      );

    if (!CLIENT_AUTH_KEY) {

      return res
        .status(403)
        .json({

          error: {

            message:
              'Forbidden: CLIENT_AUTH_KEY is not configured.',

            type:
              'authentication_error',

            code: 403

          }

        });
    }

    if (
      !token ||
      !safeTimingEqual(
        token,
        CLIENT_AUTH_KEY
      )
    ) {

      return res
        .status(403)
        .json({

          error: {

            message:
              'Forbidden: Invalid or missing authentication.',

            type:
              'authentication_error',

            code: 403

          }

        });
    }

    next();
  }
);


// ============================================================
// SAFE ERROR HANDLING
// ============================================================
//
// DO NOT do:
//
// JSON.stringify(error)
//
// or:
//
// JSON.stringify(error.response)
//
// Axios errors contain circular Node.js HTTP objects.
//
// That was causing:
//
// Converting circular structure to JSON
//
// ============================================================

function getSafeUpstreamError(
  error
) {

  const status =
    Number(
      error?.response?.status
    ) || 500;

  const data =
    error?.response?.data;

  let message =
    error?.message ||
    'Kimi request failed.';


  if (
    typeof data === 'string' &&
    data.trim()
  ) {

    message =
      data.trim();

  } else if (
    data &&
    typeof data === 'object'
  ) {

    if (
      typeof data?.error?.message ===
      'string'
    ) {

      message =
        data.error.message;

    } else if (
      typeof data?.message ===
      'string'
    ) {

      message =
        data.message;
    }
  }


  return {

    status,

    message:
      String(message),

    upstream:
      'nvidia',

    model:
      KIMI_MODEL
  };
}


function logSafeAxiosError(
  prefix,
  error
) {

  const info =
    getSafeUpstreamError(
      error
    );

  console.error(
    `${prefix} status=${info.status} ` +
    `model=${info.model} ` +
    `message=${info.message}`
  );

  if (
    error?.code
  ) {

    console.error(
      `${prefix} axios_code=${String(
        error.code
      )}`
    );
  }

  return info;
}


// ============================================================
// CALL NVIDIA KIMI
// ============================================================

async function callKimi(
  requestBody
) {

  return axios.post(

    `${NIM_API_BASE}/chat/completions`,

    {
      ...requestBody,

      model:
        KIMI_MODEL
    },

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

      // We handle upstream HTTP
      // errors ourselves.
      validateStatus:
        () => true

    }
  );
}


// ============================================================
// HEALTH
// ============================================================

app.get(
  '/',
  (req, res) => {

    res.json({

      status:
        'ok',

      service:
        'kimi-k2.6-openai-proxy',

      endpoint:
        '/v1/chat/completions'

    });
  }
);


app.get(
  '/health',
  (req, res) => {

    res.json({

      status:
        'ok',

      model:
        KIMI_MODEL,

      context_tokens:
        CONTEXT_LENGTH,

      max_output_tokens:
        MAX_TOKENS_LIMIT,

      thinking:
        ENABLE_THINKING_MODE,

      streaming:
        true,

      version:
        '4.0.0'

    });
  }
);


// ============================================================
// MODELS
// ============================================================

function modelsResponse() {

  const now =
    Math.floor(
      Date.now() / 1000
    );

  return {

    object:
      'list',

    data: [

      {

        id:
          'kimi-k2.6',

        object:
          'model',

        created:
          now,

        owned_by:
          'moonshotai'

      },

      // Compatibility alias.
      // It still routes to Kimi.
      {

        id:
          'gpt-4-turbo',

        object:
          'model',

        created:
          now,

        owned_by:
          'moonshotai'

      }

    ]

  };
}


app.get(
  '/v1/models',
  (req, res) => {

    res.json(
      modelsResponse()
    );
  }
);


app.get(
  '/models',
  (req, res) => {

    res.json(
      modelsResponse()
    );
  }
);


// ============================================================
// NORMALIZE REQUEST
// ============================================================

function normalizeNumber(
  value,
  fallback
) {

  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : fallback;
}


function buildKimiRequest(
  body
) {

  const {

    messages,

    temperature,

    max_tokens,

    max_completion_tokens,

    stream,

    top_p,

    tools,

    tool_choice,

    seed,

    stream_options,

    response_format

  } = body || {};


  if (
    !Array.isArray(messages) ||
    messages.length === 0
  ) {

    const error =
      new Error(
        'messages must be a non-empty array'
      );

    error.statusCode = 400;

    throw error;
  }


  // ==========================================================
  // TEMPERATURE
  // ==========================================================

  const rawTemperature =

    temperature === undefined

      ? 0.7

      : normalizeNumber(
          temperature,
          0.7
        );


  const safeTemperature =
    Math.max(
      0,
      Math.min(
        rawTemperature,
        1
      )
    );


  // ==========================================================
  // MAX TOKENS
  // ==========================================================

  let requested;

  if (
    max_tokens !== undefined
  ) {

    requested =
      normalizeNumber(
        max_tokens,
        8192
      );

  } else if (
    max_completion_tokens !==
    undefined
  ) {

    requested =
      normalizeNumber(
        max_completion_tokens,
        8192
      );

  } else {

    requested =
      8192;
  }


  const safeMaxTokens =
    Math.max(

      1,

      Math.min(

        Math.floor(
          requested
        ),

        MAX_TOKENS_LIMIT

      )

    );


  // ==========================================================
  // BASE REQUEST
  // ==========================================================

  const baseRequest = {

    messages,

    temperature:
      safeTemperature,

    max_tokens:
      safeMaxTokens,

    stream:
      Boolean(stream)

  };


  if (
    top_p !== undefined
  ) {

    const p =
      normalizeNumber(
        top_p,
        1
      );

    baseRequest.top_p =
      Math.max(
        0,
        Math.min(
          p,
          1
        )
      );
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
    response_format !== undefined
  ) {

    baseRequest.response_format =
      response_format;
  }


  // ==========================================================
  // KIMI THINKING
  // ==========================================================

  baseRequest.chat_template_kwargs = {

    thinking:
      ENABLE_THINKING_MODE

  };


  return baseRequest;
}


// ============================================================
// CHAT COMPLETIONS HANDLER
// ============================================================

async function handleChatCompletions(
  req,
  res
) {

  let upstreamStream =
    null;

  try {

    const requestBody =
      buildKimiRequest(
        req.body
      );


    console.log(

      `[KIMI] Request | ` +

      `messages=${requestBody.messages.length} ` +

      `max_tokens=${requestBody.max_tokens} ` +

      `stream=${requestBody.stream} ` +

      `thinking=${ENABLE_THINKING_MODE}`

    );


    const response =
      await callKimi(
        requestBody
      );


    // ========================================================
    // UPSTREAM ERROR
    // ========================================================

    if (
      response.status < 200 ||
      response.status >= 300
    ) {

      // Streaming error response.
      if (
        response.data &&
        typeof response.data.on ===
          'function'
      ) {

        let raw =
          '';

        response.data.setEncoding(
          'utf8'
        );


        await new Promise(
          (resolve) => {

            const onData =
              (chunk) => {

                raw +=
                  String(chunk);

                if (
                  raw.length >
                  10000
                ) {

                  response.data.destroy();
                }
              };


            response.data.on(
              'data',
              onData
            );

            response.data.on(
              'end',
              resolve
            );

            response.data.on(
              'close',
              resolve
            );

            response.data.on(
              'error',
              resolve
            );

          }
        );


        let message =
          `NVIDIA returned HTTP ${response.status}`;


        try {

          const parsed =
            JSON.parse(
              raw
            );

          if (
            parsed?.error?.message
          ) {

            message =
              parsed.error.message;
          }

        } catch {

          if (
            raw.trim()
          ) {

            message =
              raw
                .trim()
                .slice(
                  0,
                  1000
                );
          }
        }


        return res
          .status(
            response.status
          )
          .json({

            error: {

              message,

              type:
                'upstream_error',

              code:
                response.status,

              upstream:
                'nvidia',

              model:
                KIMI_MODEL

            }

          });
      }


      const info =
        getSafeUpstreamError({

          message:
            `NVIDIA returned HTTP ${response.status}`,

          response: {

            status:
              response.status,

            data:
              response.data

          }

        });


      return res
        .status(
          info.status
        )
        .json({

          error: {

            message:
              info.message,

            type:
              'upstream_error',

            code:
              info.status,

            upstream:
              info.upstream,

            model:
              info.model

          }

        });
    }


    upstreamStream =
      requestBody.stream
        ? response.data
        : null;


    console.log(
      '[KIMI] NVIDIA response received.'
    );


    // ========================================================
    // STREAMING
    // ========================================================

    if (
      requestBody.stream
    ) {

      res.statusCode =
        200;


      res.setHeader(
        'Content-Type',
        'text/event-stream; charset=utf-8'
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


      if (
        typeof res.flushHeaders ===
        'function'
      ) {

        res.flushHeaders();
      }


      const decoder =
        new StringDecoder(
          'utf8'
        );


      let buffer =
        '';

      let doneSent =
        false;

      let reasoningOpen =
        false;

      let streamEndedCleanly =
        false;

      let cleaned =
        false;


      function cleanup() {

        if (
          cleaned
        ) {

          return;
        }

        cleaned =
          true;


        if (
          upstreamStream
        ) {

          upstreamStream.removeAllListeners(
            'data'
          );

          upstreamStream.removeAllListeners(
            'end'
          );

          upstreamStream.removeAllListeners(
            'error'
          );
        }


        req.removeAllListeners(
          'close'
        );
      }


      function safeWriteSSE(
        value
      ) {

        if (
          res.writableEnded ||
          res.destroyed ||
          !res.writable
        ) {

          return false;
        }


        try {

          res.write(
            value
          );

          return true;

        } catch {

          return false;
        }
      }


      function sendDone() {

        if (
          !doneSent
        ) {

          safeWriteSSE(
            'data: [DONE]\n\n'
          );

          doneSent =
            true;
        }
      }


      function processLine(
        line
      ) {

        if (
          !line.startsWith(
            'data:'
          )
        ) {

          return;
        }


        const payload =
          line
            .slice(5)
            .trim();


        if (
          !payload
        ) {

          return;
        }


        if (
          payload ===
          '[DONE]'
        ) {

          sendDone();

          streamEndedCleanly =
            true;

          return;
        }


        let data;


        try {

          data =
            JSON.parse(
              payload
            );

        } catch {

          return;
        }


        const delta =
          data
            ?.choices?.[0]
            ?.delta;


        if (
          delta &&
          typeof delta ===
            'object'
        ) {

          const reasoning =
            delta.reasoning_content;

          const normalContent =
            delta.content;


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
              normalContent &&
              reasoningOpen
            ) {

              delta.content =
                `\n</thinking>\n\n${normalContent}`;

              reasoningOpen =
                false;

            } else {

              delta.content =
                normalContent || '';

            }
          }


          // Normally Janitor only needs
          // normal assistant content.

          if (
            !SHOW_REASONING
          ) {

            delete delta.reasoning_content;
          }
        }


        safeWriteSSE(

          `data: ${JSON.stringify(
            data
          )}\n\n`

        );
      }


      // ======================================================
      // STREAM DATA
      // ======================================================

      upstreamStream.on(
        'data',
        (chunk) => {

          buffer +=
            decoder.write(
              chunk
            );


          if (
            buffer.length >
            MAX_BUFFER_SIZE
          ) {

            safeWriteSSE(

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
            buffer.split(
              '\n'
            );


          buffer =
            lines.pop() ||
            '';


          for (
            const line
            of lines
          ) {

            processLine(
              line.replace(
                /\r$/,
                ''
              )
            );
          }

        }
      );


      // ======================================================
      // STREAM END
      // ======================================================

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
              of buffer.split(
                '\n'
              )
            ) {

              processLine(
                line.replace(
                  /\r$/,
                  ''
                )
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


      // ======================================================
      // STREAM ERROR
      // ======================================================

      upstreamStream.on(
        'error',
        (err) => {

          console.error(

            `[STREAM] NVIDIA stream error: ` +

            `${String(
              err?.message ||
              err
            )}`

          );


          if (
            !res.writableEnded
          ) {

            safeWriteSSE(

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


      // ======================================================
      // CLIENT DISCONNECT
      // ======================================================

      req.on(
        'close',
        () => {

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
    // NON-STREAM RESPONSE
    // ========================================================

    const data =
      response.data;


    if (
      !data ||
      typeof data !== 'object'
    ) {

      return res
        .status(502)
        .json({

          error: {

            message:
              'NVIDIA returned an invalid response.',

            type:
              'upstream_error',

            code:
              502,

            upstream:
              'nvidia',

            model:
              KIMI_MODEL

          }

        });
    }


    // NVIDIA already returns
    // OpenAI-compatible JSON.
    //
    // Don't rebuild it.
    // This preserves:
    // - tool calls
    // - usage
    // - finish_reason
    // - IDs
    // - other fields

    return res
      .status(200)
      .json(data);


  } catch (
    error
  ) {

    // ========================================================
    // IMPORTANT:
    // SAFE LOGGING ONLY.
    // ========================================================

    const info =
      logSafeAxiosError(
        '[PROXY] Request failed:',
        error
      );


    if (
      !res.headersSent
    ) {

      const status =
        Number(
          error?.statusCode
        ) ||
        info.status;


      return res
        .status(status)
        .json({

          error: {

            message:
              info.message,

            type:
              error?.statusCode
                ? 'invalid_request_error'
                : 'proxy_error',

            code:
              status,

            upstream:
              'nvidia',

            model:
              KIMI_MODEL

          }

        });
    }


    // If streaming headers
    // have already been sent.

    if (
      !res.writableEnded
    ) {

      try {

        res.write(

          `data: ${JSON.stringify({

            error: {

              message:
                info.message,

              type:
                'proxy_error',

              upstream:
                'nvidia',

              model:
                KIMI_MODEL

            }

          })}\n\n`

        );


        res.write(
          'data: [DONE]\n\n'
        );

      } catch {}


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


// ============================================================
// ENDPOINTS
// ============================================================

// Standard OpenAI endpoint.
app.post(
  '/v1/chat/completions',
  handleChatCompletions
);


// Janitor compatibility.
// This fixes:
// POST /v1 -> 404
app.post(
  '/v1',
  handleChatCompletions
);


// Trailing slash compatibility.
app.post(
  '/v1/',
  handleChatCompletions
);


// ============================================================
// 404
// ============================================================

app.use(
  (req, res) => {

    res
      .status(404)
      .json({

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


// ============================================================
// MODEL VALIDATION
// ============================================================

async function validateModels() {

  if (
    SKIP_VALIDATION
  ) {

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
            VALIDATION_TIMEOUT_MS,

          validateStatus:
            () => true

        }

      );


    if (
      response.status < 200 ||
      response.status >= 300
    ) {

      console.warn(

        `[VALIDATION] NVIDIA /models ` +
        `returned HTTP ${response.status}`

      );


      console.warn(
        '[VALIDATION] Continuing anyway.'
      );


      return;
    }


    const ids =
      new Set(

        Array.isArray(
          response.data?.data
        )

          ? response.data.data
              .map(
                (model) =>
                  model?.id
              )
              .filter(Boolean)

          : []

      );


    if (
      ids.has(
        KIMI_MODEL
      )
    ) {

      console.log(
        `[VALIDATION] ✓ ${KIMI_MODEL}`
      );

    } else {

      console.warn(

        `[VALIDATION] ! ${KIMI_MODEL} ` +
        `was not listed by /v1/models.`

      );


      console.warn(

        '[VALIDATION] This does not automatically ' +
        'mean inference is unavailable.'

      );
    }


  } catch (
    error
  ) {

    console.warn(

      `[VALIDATION] Could not check /models: ` +

      `${String(
        error?.message ||
        error
      )}`

    );


    console.warn(

      '[VALIDATION] Continuing because ' +
      'the inference endpoint is the real test.'

    );
  }
}


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
      `[PROXY] Context: ${CONTEXT_LENGTH / 1024}K`
    );

    console.log(
      `[PROXY] Max output: ${MAX_TOKENS_LIMIT}`
    );

    console.log(

      `[PROXY] Thinking: ` +
      `${ENABLE_THINKING_MODE ? 'ON' : 'OFF'}`

    );

    console.log(
      '================================================'
    );


    validateModels()
      .catch(
        (error) => {

          console.error(

            `[VALIDATION] Startup check failed: ` +

            `${String(
              error?.message ||
              error
            )}`

          );

        }
      );

  }
);
