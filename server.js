require("dotenv").config({ quiet: true });

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;


const app = express();
app.use(express.urlencoded({ extended: false }));

const CLONE_THRESHOLD_BYTES = 3 * 8000;
const PROCESS_INTERVAL_MS = 3000;
const MEDIA_STATS_INTERVAL_MS = 5000;
const ULAW_SAMPLE_RATE = 8000;
const API_ERROR_PREVIEW_CHARS = 500;
const VALID_CALL_MODES = new Set(["diagnostic", "tts_test", "full", "portfolio_demo"]);
const RAW_CALL_MODE = process.env.CALL_MODE || "diagnostic";
const CALL_MODE = VALID_CALL_MODES.has(RAW_CALL_MODE) ? RAW_CALL_MODE : "diagnostic";
const TTS_TEST_PHRASE = "This is ElevenLabs audio over Twilio media.";
const PORTFOLIO_QUEUE_GREETING_TEXT =
  "Please wait... while we connect you over.";
const PORTFOLIO_CAPTURE_PROMPT_TEXT =
  "After the tone, say anything you want to ask, give me any details, or explain why you are calling.";
const PORTFOLIO_PUTTING_THROUGH_TEXT = "One second. Connecting you over now.";
const PORTFOLIO_FIRST_CLONE_REPLY = "Yeah? I am kind of in the middle of something.";
const PORTFOLIO_FALLBACK_TRANSCRIPT = "The caller is speaking into the phone.";
const PORTFOLIO_FALLBACK_REPLY = "Yeah? I am kind of in the middle of something.";
const PORTFOLIO_CAPTURE_SECONDS = Math.max(
  8,
  Number.parseFloat(process.env.PORTFOLIO_CAPTURE_SECONDS || "10")
);
const PORTFOLIO_CAPTURE_BYTES = Math.floor(PORTFOLIO_CAPTURE_SECONDS * ULAW_SAMPLE_RATE);
const PORTFOLIO_BUZZER_MS = 450;
const PORTFOLIO_BUZZER_HZ = 880;
const PORTFOLIO_JINGLE_MARK = "portfolio-jingle";
const PORTFOLIO_TRANSFER_VIBRATION_MARK = "portfolio-transfer-vibration";
const PORTFOLIO_CONVERSATION_MAX_TURNS = 30;
const PORTFOLIO_TURN_MIN_BYTES = Math.floor(0.35 * ULAW_SAMPLE_RATE);
const PORTFOLIO_TURN_MAX_BYTES = Math.floor(3.2 * ULAW_SAMPLE_RATE);
const PORTFOLIO_TURN_NO_SPEECH_BYTES = Math.floor(5.0 * ULAW_SAMPLE_RATE);
const PORTFOLIO_TURN_SILENCE_MS = 420;
const PORTFOLIO_SPEECH_RMS_THRESHOLD = 1200;
const PORTFOLIO_SILENCE_RMS_THRESHOLD = 850;
const PORTFOLIO_BARGE_IN_RMS_THRESHOLD = 1500;
const PORTFOLIO_BARGE_IN_MIN_CHUNKS = 4;
const PORTFOLIO_THINKING_FILLER_DELAY_MS = Number.parseInt(
  process.env.PORTFOLIO_THINKING_FILLER_DELAY_MS || "700",
  10
);
const PORTFOLIO_MAIN_STT_TIMEOUT_MS = Number.parseInt(process.env.PORTFOLIO_MAIN_STT_TIMEOUT_MS || "8000", 10);
const PORTFOLIO_CONVERSATION_STT_TIMEOUT_MS = Number.parseInt(process.env.PORTFOLIO_CONVERSATION_STT_TIMEOUT_MS || "2800", 10);
const PORTFOLIO_ANTHROPIC_TIMEOUT_MS = Number.parseInt(process.env.PORTFOLIO_ANTHROPIC_TIMEOUT_MS || "3000", 10);
const PORTFOLIO_TTS_TIMEOUT_MS = Number.parseInt(process.env.PORTFOLIO_TTS_TIMEOUT_MS || "5000", 10);
const WS_OPEN_STATE = 1;
const PORTFOLIO_LIMITS = {
  cloneAttempts: 1,
  sttCalls: 35,
  anthropicCalls: 35,
  spokenReplies: 80,
};

const sessions = new Map();
const activeTimers = new Map();

function hasEnv(name) {
  return Boolean(process.env[name]);
}

function getQueueVoiceId() {
  return (
    process.env.ELEVENLABS_QUEUE_VOICE_ID ||
    process.env.ELEVENLABS_GENERIC_VOICE_ID ||
    process.env.ELEVENLABS_FALLBACK_VOICE_ID ||
    process.env.ELEVENLABS_TEST_VOICE_ID ||
    process.env.ELEVENLABS_VOICE_ID ||
    process.env.ELEVENLABS_DEFAULT_VOICE_ID ||
    process.env.FALLBACK_VOICE_ID ||
    process.env.VOICE_ID ||
    ""
  );
}

function getCloneFallbackVoiceId() {
  return (
    process.env.ELEVENLABS_CLONE_FALLBACK_VOICE_ID ||
    process.env.ELEVENLABS_FALLBACK_VOICE_ID ||
    process.env.ELEVENLABS_QUEUE_VOICE_ID ||
    process.env.ELEVENLABS_GENERIC_VOICE_ID ||
    process.env.ELEVENLABS_TEST_VOICE_ID ||
    process.env.ELEVENLABS_VOICE_ID ||
    process.env.ELEVENLABS_DEFAULT_VOICE_ID ||
    process.env.FALLBACK_VOICE_ID ||
    process.env.VOICE_ID ||
    ""
  );
}

function getTestVoiceId() {
  return getQueueVoiceId();
}

function getPortfolioMissingEnv() {
  const missing = [];
  if (!hasEnv("ELEVENLABS_API_KEY")) missing.push("ELEVENLABS_API_KEY");
  if (!getQueueVoiceId()) {
    missing.push("ELEVENLABS_QUEUE_VOICE_ID or ELEVENLABS_FALLBACK_VOICE_ID or ELEVENLABS_TEST_VOICE_ID");
  }
  return missing;
}

function shortId(value) {
  if (!value) return "missing";
  if (value.length <= 8) return "[redacted]";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function callLabel(callSid) {
  return callSid || "unknown-call";
}

function timerKey(label, callSid) {
  return `${callLabel(callSid)}:${label}`;
}

function startTimer(label, callSid) {
  activeTimers.set(timerKey(label, callSid), Date.now());
  console.log(`[${callLabel(callSid)}] TIMER_START ${label}`);
}

function endTimer(label, callSid) {
  const key = timerKey(label, callSid);
  const startedAt = activeTimers.get(key);
  if (!startedAt) {
    console.log(`[${callLabel(callSid)}] TIMER_END ${label} ms=unknown`);
    return;
  }
  activeTimers.delete(key);
  console.log(`[${callLabel(callSid)}] TIMER_END ${label} ms=${Date.now() - startedAt}`);
}

function truncateForLog(value, maxLength = API_ERROR_PREVIEW_CHARS) {
  if (value === undefined || value === null) return "";
  const text = String(value).replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

async function readResponsePreview(response) {
  try {
    return truncateForLog(await response.text());
  } catch (err) {
    return `failed to read response body: ${err.message}`;
  }
}

function logApiHttpError(stage, callSid, status, bodyPreview, level = "error") {
  const message = `[${callLabel(callSid)}] API_${level.toUpperCase()} stage=${stage} status=${status || "unknown"} body="${truncateForLog(bodyPreview)}"`;
  if (level === "warn") {
    console.warn(message);
  } else {
    console.error(message);
  }
}

function logApiError(stage, callSid, err, level = "error") {
  const status = err?.status || err?.statusCode || err?.response?.status || "unknown";
  const bodyPreview = err?.body || err?.response?.body || err?.message || "";
  logApiHttpError(stage, callSid, status, bodyPreview, level);
}

function takePortfolioLimit(session, key, max, label) {
  if (session[key] >= max) {
    console.warn(
      `[${callLabel(session.callSid)}] PORTFOLIO_LIMIT_BLOCKED type=${label} count=${session[key]} max=${max}`
    );
    return false;
  }
  session[key] += 1;
  return true;
}

function parseInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isCallOpen(session, ws) {
  return Boolean(session && !session.isClosed && ws && ws.readyState === WS_OPEN_STATE && session.streamSid);
}

async function fetchWithTimeout(url, options, timeoutMs, stage, callSid) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(`[${callLabel(callSid)}] API_TIMEOUT stage=${stage} ms=${timeoutMs}`);
      throw new Error(`${stage} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs, stage, callSid) {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      console.warn(`[${callLabel(callSid)}] API_TIMEOUT stage=${stage} ms=${timeoutMs}`);
      reject(new Error(`${stage} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function looksLikeBadSttTranscript(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return true;

  const words = normalized.split(" ").filter(Boolean);
  if (words.length === 0) return true;

  const wobCount = words.filter((word) => word === "wob" || word === "wah" || word === "blah").length;
  if (wobCount >= 5 && wobCount / words.length > 0.5) return true;

  const uniqueWords = new Set(words);
  if (words.length >= 10 && uniqueWords.size <= 3) return true;

  return false;
}

function sanitizePhoneReply(text) {
  const cleaned = String(text || "")
    .replace(/\*/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return "Hang on, say that again—I missed part of it.";

  const withoutMeta = cleaned
    .replace(/\b(AI|bot|Claude|ElevenLabs|Twilio|API|clone|voice cloning|demo)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  return withoutMeta || "Hang on, say that again—I missed part of it.";
}

function logBoot(PORT) {
  console.log("APP_STARTED service=voice-clone-phone");
  console.log(`NODE_ENV=${process.env.NODE_ENV || "unset"}`);
  if (!VALID_CALL_MODES.has(RAW_CALL_MODE)) {
    console.warn(`INVALID_CALL_MODE value=${RAW_CALL_MODE} using=diagnostic`);
  }
  console.log(`CALL_MODE=${CALL_MODE}`);
  console.log(`ANTHROPIC_API_KEY=${hasEnv("ANTHROPIC_API_KEY") ? "present" : "missing"}`);
  console.log(`ELEVENLABS_API_KEY=${hasEnv("ELEVENLABS_API_KEY") ? "present" : "missing"}`);
  console.log(`ELEVENLABS_QUEUE_VOICE_ID=${getQueueVoiceId() ? "present" : "missing"}`);
  console.log(`ELEVENLABS_CLONE_FALLBACK_VOICE_ID=${getCloneFallbackVoiceId() ? "present" : "missing"}`);
  console.log(`PORT=${PORT}`);
}

function updateSequenceDiagnostics(session, data) {
  const sequenceNumber = parseInteger(data.sequenceNumber);
  if (sequenceNumber === null) return;

  if (session.expectedSequenceNumber !== null && sequenceNumber !== session.expectedSequenceNumber) {
    session.sequenceGaps += 1;
    console.warn(
      `[${callLabel(session.callSid)}] TWILIO_SEQUENCE_GAP expected=${session.expectedSequenceNumber} got=${sequenceNumber}`
    );
  }
  session.expectedSequenceNumber = sequenceNumber + 1;
}

function updateTimestampDiagnostics(session, data) {
  const timestamp = parseInteger(data.media?.timestamp);
  if (timestamp === null) return;

  if (session.lastTwilioTimestamp !== null) {
    if (timestamp < session.lastTwilioTimestamp) {
      session.timestampJumps += 1;
      console.warn(
        `[${callLabel(session.callSid)}] TWILIO_TIMESTAMP_BACKWARD previous=${session.lastTwilioTimestamp} current=${timestamp}`
      );
    } else if (timestamp - session.lastTwilioTimestamp > 1000) {
      session.timestampJumps += 1;
      console.warn(
        `[${callLabel(session.callSid)}] TWILIO_TIMESTAMP_LARGE_JUMP previous=${session.lastTwilioTimestamp} current=${timestamp}`
      );
    }
  }
  session.lastTwilioTimestamp = timestamp;
}

function logMediaStats(session, reason = "interval") {
  const elapsedSeconds = Math.max((Date.now() - session.statsStartedAt) / 1000, 0.001);
  const audioSeconds = session.allBytes / ULAW_SAMPLE_RATE;
  const averageBytesPerSecond = session.allBytes / elapsedSeconds;
  console.log(
    `[${callLabel(session.callSid)}] MEDIA_STATS reason=${reason} streamSid=${session.streamSid || "unknown"} packets=${session.packetCount} bytes=${session.allBytes} approxAudioSeconds=${audioSeconds.toFixed(2)} avgBytesPerSecond=${averageBytesPerSecond.toFixed(2)} lastTwilioTimestamp=${session.lastTwilioTimestamp ?? "missing"} sequenceGaps=${session.sequenceGaps} timestampJumps=${session.timestampJumps}`
  );
}

function cleanupSession(session, reason, extra = {}) {
  if (session.cleanupLogged) {
    session.isClosed = true;
    return;
  }
  session.cleanupLogged = true;
  session.isClosed = true;
  session.portfolioConversationActive = false;
  session.portfolioConversationChunks = [];
  session.portfolioConversationBytes = 0;

  if (session.processingTimer) {
    clearInterval(session.processingTimer);
    session.processingTimer = null;
  }
  if (session.statsTimer) {
    clearInterval(session.statsTimer);
    session.statsTimer = null;
  }
  if (session.portfolioQuickAckTimer) {
    clearTimeout(session.portfolioQuickAckTimer);
    session.portfolioQuickAckTimer = null;
  }
  if (session.portfolioCaptureStartFallbackTimer) {
    clearTimeout(session.portfolioCaptureStartFallbackTimer);
    session.portfolioCaptureStartFallbackTimer = null;
  }
  const closeInfo = extra.code ? ` code=${extra.code} reason="${truncateForLog(extra.reason || "")}"` : "";
  console.log(
    `[${callLabel(session.callSid)}] CALL_${reason.toUpperCase()} streamSid=${session.streamSid || "unknown"} packets=${session.packetCount} bytes=${session.allBytes} approxSeconds=${(session.allBytes / ULAW_SAMPLE_RATE).toFixed(2)}${closeInfo}`
  );

  if (session.streamSid) {
    sessions.delete(session.streamSid);
  }

  const cleanupVoiceId = CALL_MODE === "portfolio_demo" ? session.portfolioCreatedVoiceId : session.voiceId;
  if ((CALL_MODE === "full" || CALL_MODE === "portfolio_demo") && cleanupVoiceId && !session.voiceCleanupStarted) {
    const voiceId = cleanupVoiceId;
    session.voiceId = null;
    session.portfolioCreatedVoiceId = null;
    session.voiceCleanupStarted = true;
    deleteVoice(voiceId, session.callSid);
  }
}

function sendAudioToTwilio(ws, streamSid, audioBuffer, markName, callSid) {
  startTimer("Twilio media send", callSid);
  try {
    if (!streamSid) {
      console.warn(`[${callLabel(callSid)}] TWILIO_MEDIA_SEND_SKIPPED reason=missing_streamSid`);
      return false;
    }
    if (ws.readyState !== WS_OPEN_STATE) {
      console.warn(`[${callLabel(callSid)}] TWILIO_MEDIA_SEND_SKIPPED reason=websocket_not_open readyState=${ws.readyState}`);
      return false;
    }

    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: audioBuffer.toString("base64") },
    }));
    console.log(`[${callLabel(callSid)}] TWILIO_MEDIA_SEND bytes=${audioBuffer.length} streamSid=${streamSid}`);

    if (markName) {
      ws.send(JSON.stringify({
        event: "mark",
        streamSid,
        mark: { name: markName },
      }));
      console.log(`[${callLabel(callSid)}] TWILIO_MARK_SENT name=${markName}`);
    }

    return true;
  } finally {
    endTimer("Twilio media send", callSid);
  }
}

function sendTwilioClear(ws, streamSid, callSid, reason = "barge-in") {
  if (!streamSid) {
    console.warn(`[${callLabel(callSid)}] TWILIO_CLEAR_SKIPPED reason=missing_streamSid clearReason=${reason}`);
    return false;
  }
  if (ws.readyState !== WS_OPEN_STATE) {
    console.warn(`[${callLabel(callSid)}] TWILIO_CLEAR_SKIPPED reason=websocket_not_open readyState=${ws.readyState} clearReason=${reason}`);
    return false;
  }
  ws.send(JSON.stringify({
    event: "clear",
    streamSid,
  }));
  console.log(`[${callLabel(callSid)}] PORTFOLIO_BARGE_IN_CLEAR_SENT reason=${reason}`);
  return true;
}

app.get("/", (req, res) => res.send("server running"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "voice-clone-phone",
    callMode: CALL_MODE,
    hasAnthropicKey: hasEnv("ANTHROPIC_API_KEY"),
    hasElevenLabsKey: hasEnv("ELEVENLABS_API_KEY"),
    hasFixedVoiceId: Boolean(getQueueVoiceId()),
    fixedVoiceIdPreview: shortId(getQueueVoiceId()),
    hasQueueVoiceId: Boolean(getQueueVoiceId()),
    queueVoiceIdPreview: shortId(getQueueVoiceId()),
    hasCloneFallbackVoiceId: Boolean(getCloneFallbackVoiceId()),
    cloneFallbackVoiceIdPreview: shortId(getCloneFallbackVoiceId()),
    portfolioCaptureSeconds: PORTFOLIO_CAPTURE_SECONDS,
    portfolioTurnSilenceMs: PORTFOLIO_TURN_SILENCE_MS,
    portfolioThinkingFillerDelayMs: PORTFOLIO_THINKING_FILLER_DELAY_MS,
  });
});

app.post("/stream-status", (req, res) => {
  const fields = [
    "AccountSid",
    "CallSid",
    "StreamSid",
    "StreamName",
    "StreamEvent",
    "StreamError",
    "Timestamp",
  ];
  const safeBody = {};
  for (const field of fields) {
    if (req.body[field]) safeBody[field] = truncateForLog(req.body[field], 200);
  }
  console.log(`TWILIO_STREAM_STATUS ${JSON.stringify(safeBody)}`);
  res.sendStatus(204);
});

function handleVoiceWebhook(req, res) {
  const host = req.headers.host;
  const body = req.body || {};
  const query = req.query || {};
  const callSid = body.CallSid || query.CallSid || "missing";
  const from = body.From || query.From || "missing";
  const to = body.To || query.To || "missing";

  console.log(
    `TWILIO_VOICE_HIT timestamp=${new Date().toISOString()} host=${host || "missing"} callMode=${CALL_MODE} method=${req.method} CallSid=${callSid} From=${from} To=${to}`
  );

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${host}/media`,
    statusCallback: `https://${host}/stream-status`,
    statusCallbackMethod: "POST",
  });

  res.type("text/xml");
  res.send(twiml.toString());
}

app.get("/voice", handleVoiceWebhook);
app.post("/voice", handleVoiceWebhook);

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log(`TWILIO_WS_CONNECTED callMode=${CALL_MODE}`);

  let session = {
    streamSid: null,
    callSid: null,
    allChunks: [],
    allBytes: 0,
    utteranceChunks: [],
    isProcessing: false,
    processingTimer: null,
    voiceId: null,
    cloneGeneration: 0,
    history: [],
    gatheredInfo: {},
    statsStartedAt: Date.now(),
    statsTimer: null,
    packetCount: 0,
    firstMediaLogged: false,
    expectedSequenceNumber: null,
    sequenceGaps: 0,
    lastTwilioTimestamp: null,
    timestampJumps: 0,
    ttsTestStarted: false,
    voiceCleanupStarted: false,
    isClosed: false,
    portfolioEnvReady: false,
    portfolioOpeningStarted: false,
    portfolioQuickAckStarted: false,
    portfolioQuickAckTimer: null,
    portfolioCaptureStartFallbackTimer: null,
    portfolioCaptureStarted: false,
    portfolioCaptureChunks: [],
    portfolioCaptureBytes: 0,
    portfolioMainStarted: false,
    portfolioCreatedVoiceId: null,
    portfolioCloneAttempts: 0,
    portfolioSttCalls: 0,
    portfolioAnthropicCalls: 0,
    portfolioTtsCalls: 0,
    portfolioSpokenReplies: 0,
    portfolioConversationActive: false,
    portfolioConversationIsProcessing: false,
    portfolioConversationTurn: 0,
    portfolioConversationChunks: [],
    portfolioConversationBytes: 0,
    portfolioConversationSpeechSeen: false,
    portfolioConversationSilentMs: 0,
    portfolioConversationVoiceId: null,
    portfolioAiSpeaking: false,
    portfolioAiSpeakingMark: null,
    portfolioBargeInChunks: 0,
    portfolioPendingHangupMark: null,
    portfolioThinkingFillerActive: false,
  };

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      updateSequenceDiagnostics(session, data);

      if (data.event === "connected") {
        console.log(
          `[${callLabel(session.callSid)}] TWILIO_CONNECTED protocol=${data.protocol || "missing"} version=${data.version || "missing"}`
        );
      }

      if (data.event === "start") {
        session.streamSid = data.start.streamSid;
        session.callSid = data.start.callSid;
        session.statsStartedAt = Date.now();
        sessions.set(session.streamSid, session);
        if (session.statsTimer) clearInterval(session.statsTimer);
        session.statsTimer = setInterval(() => logMediaStats(session), MEDIA_STATS_INTERVAL_MS);
        console.log(
          `[${callLabel(session.callSid)}] TWILIO_START streamSid=${session.streamSid || "missing"} mediaFormat=${JSON.stringify(data.start.mediaFormat || {})} tracks=${JSON.stringify(data.start.tracks || [])} customParameters=${JSON.stringify(data.start.customParameters || {})}`
        );

        if (CALL_MODE === "tts_test" && !session.ttsTestStarted) {
          session.ttsTestStarted = true;
          runTtsTest(session, ws).catch((err) => logApiError("tts_test", session.callSid, err));
        }

        if (CALL_MODE === "portfolio_demo" && !session.portfolioOpeningStarted) {
          const missing = getPortfolioMissingEnv();
          session.portfolioEnvReady = missing.length === 0;
          if (!session.portfolioEnvReady) {
            console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_MISSING_ENV names="${missing.join(", ")}"`);
          } else {
            if (!hasEnv("ANTHROPIC_API_KEY")) {
              console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_OPTIONAL_ENV_MISSING names="ANTHROPIC_API_KEY" action="using fixed/fallback replies"`);
            }
            session.portfolioOpeningStarted = true;
            runPortfolioOpening(session, ws).catch((err) => logApiError("portfolio_opening", session.callSid, err));
          }
        }
      }

      if (data.event === "media") {
        if (!data.media?.payload) return;

        const chunk = Buffer.from(data.media.payload, "base64");
        session.packetCount += 1;
        session.allBytes += chunk.length;
        updateTimestampDiagnostics(session, data);

        if (!session.firstMediaLogged) {
          session.firstMediaLogged = true;
          console.log(
            `[${callLabel(session.callSid)}] FIRST_MEDIA_PACKET bytes=${chunk.length} twilioTimestamp=${data.media.timestamp ?? "missing"} sequenceNumber=${data.sequenceNumber ?? "missing"}`
          );
        }

        if (CALL_MODE === "portfolio_demo") {
          if (
            session.portfolioAiSpeaking &&
            !session.portfolioConversationActive &&
            !session.portfolioConversationIsProcessing
          ) {
            const bargeRms = mulawRms(chunk);
            if (bargeRms >= PORTFOLIO_BARGE_IN_RMS_THRESHOLD) {
              session.portfolioBargeInChunks += 1;
            } else {
              session.portfolioBargeInChunks = Math.max(0, session.portfolioBargeInChunks - 1);
            }

            if (session.portfolioBargeInChunks >= PORTFOLIO_BARGE_IN_MIN_CHUNKS) {
              const interruptedMark = session.portfolioAiSpeakingMark || "portfolio-speaking";
              sendTwilioClear(ws, session.streamSid, session.callSid, interruptedMark);
              session.portfolioAiSpeaking = false;
              session.portfolioAiSpeakingMark = null;
              session.portfolioBargeInChunks = 0;
              startPortfolioConversationListening(session, "barge-in");
              if (session.portfolioConversationActive && !session.portfolioConversationIsProcessing) {
                handlePortfolioConversationMedia(session, ws, chunk);
              }
              return;
            }
          }

          if (session.portfolioConversationActive && !session.portfolioConversationIsProcessing) {
            handlePortfolioConversationMedia(session, ws, chunk);
            return;
          }

          if (session.portfolioCaptureStarted && !session.portfolioMainStarted) {
            session.portfolioCaptureChunks.push(chunk);
            session.portfolioCaptureBytes += chunk.length;

            if (
              session.portfolioEnvReady &&
              session.portfolioCaptureBytes >= PORTFOLIO_CAPTURE_BYTES
            ) {
              session.portfolioMainStarted = true;
              console.log(
                `[${callLabel(session.callSid)}] PORTFOLIO_SAMPLE_COLLECTION_DONE bytes=${session.portfolioCaptureBytes} approxSeconds=${(session.portfolioCaptureBytes / ULAW_SAMPLE_RATE).toFixed(2)}`
              );
              runPortfolioMainReply(session, ws).catch((err) => logApiError("portfolio_main_reply", session.callSid, err));
            }
          }

          return;
        }

        if (CALL_MODE !== "full") return;

        session.allChunks.push(chunk);
        session.utteranceChunks.push(chunk);

        if (!session.processingTimer && session.allBytes >= CLONE_THRESHOLD_BYTES) {
          console.log(`[${session.callSid}] starting loop...`);
          session.processingTimer = setInterval(async () => {
            if (session.isProcessing || session.utteranceChunks.length === 0) return;
            session.isProcessing = true;
            const snap = Buffer.concat(session.utteranceChunks);
            session.utteranceChunks = [];
            await handleUtterance(session, snap, ws).catch((err) => {
              console.error("error:", err);
              session.isProcessing = false;
            });
          }, PROCESS_INTERVAL_MS);
        }
      }

      if (data.event === "mark") {
        const markName = data.mark?.name || "missing";
        console.log(
          `[${callLabel(session.callSid)}] TWILIO_MARK_RECEIVED name=${markName} sequenceNumber=${data.sequenceNumber ?? "missing"}`
        );

        if (
          CALL_MODE === "portfolio_demo" &&
          session.portfolioPendingHangupMark &&
          markName === session.portfolioPendingHangupMark
        ) {
          closeCallAfterMark(session, ws, markName);
          return;
        }

        if (CALL_MODE === "portfolio_demo" && markName === "portfolio-buzzer") {
          startPortfolioCapture(session);
        }

        if (CALL_MODE === "portfolio_demo" && markName === "portfolio-reply-1") {
          session.portfolioAiSpeaking = false;
          session.portfolioAiSpeakingMark = null;
          session.portfolioBargeInChunks = 0;
          console.log(`[${callLabel(session.callSid)}] PORTFOLIO_MAIN_REPLY_MARK_DONE`);
          startPortfolioConversationListening(session, "after-first-reply");
        }

        if (
          CALL_MODE === "portfolio_demo" &&
          markName.startsWith("portfolio-conversation-reply-")
        ) {
          session.portfolioAiSpeaking = false;
          session.portfolioAiSpeakingMark = null;
          session.portfolioBargeInChunks = 0;
          startPortfolioConversationListening(session, "after-conversation-reply");
        }
      }

      if (data.event === "stop") {
        cleanupSession(session, "stop");
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", (code, reason) => {
    cleanupSession(session, "close", {
      code,
      reason: reason ? reason.toString() : "",
    });
  });

  ws.on("error", (err) => console.error(`[${callLabel(session.callSid)}] TWILIO_WS_ERROR message=${err.message}`));
});

async function handleUtterance(session, utteranceBuffer, ws) {
  try {
    if (CALL_MODE !== "full") return;

    const recentBuffer = utteranceBuffer.slice(-3 * 8000);
    const transcription = await transcribeAudio(recentBuffer, session.callSid);
    console.log(`[${session.callSid}] heard: "${transcription}"`);

    if (!transcription || transcription.trim().length === 0) {
      session.isProcessing = false;
      return;
    }

    session.history.push({ role: "user", content: transcription });

    // Run Claude AND clone creation in parallel
    const [reply, voiceId] = await Promise.all([
      getDoubleResponse(session.history, session.gatheredInfo, session.callSid),
      refreshClone(session),
    ]);

    console.log(`[${session.callSid}] double: "${reply}"`);
    session.history.push({ role: "assistant", content: reply });

    const audio = await generateTts(voiceId, reply, session.callSid);
    sendAudioToTwilio(ws, session.streamSid, audio, `full-g${session.cloneGeneration}`, session.callSid);
    console.log(`[${session.callSid}] sent gen ${session.cloneGeneration}`);
  } catch (err) {
    console.error(`[${session.callSid}] error:`, err);
  } finally {
    session.isProcessing = false;
  }
}

async function getDoubleResponse(history, gatheredInfo, callSid) {
  const infoContext = Object.keys(gatheredInfo).length > 0
    ? `What you know so far: ${JSON.stringify(gatheredInfo)}`
    : "";

  startTimer("Anthropic response generation", callSid);
  try {
    if (!anthropic) {
      throw new Error("ANTHROPIC_API_KEY is missing");
    }
    const response = await withTimeout(anthropic.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
      max_tokens: 90,
      system: `You are the other side of a live phone call.

You are a busy, distracted person who has just been interrupted. You are not a bot, not a menu, not customer service, and not a detective.

Personality: casual, specific, believable, a little impatient, and occasionally frustrated in a realistic way. You can interrupt with "wait", "hold on", "no, listen", or "okay, go on", but do not become cruel or theatrical.

Reply to what the caller actually said. Use the conversation history. Answer direct questions instead of dodging them. If you do not know something, react like a real person: guess, push back, or ask for the missing detail.

You are allowed to talk about yourself sometimes: what you are in the middle of, why you sound busy, what this call is interrupting, or why the caller's question is confusing. Do not only ask questions. Sometimes move the conversation forward yourself.

Keep replies natural for a phone call: usually 8 to 24 words, one or two sentences. Occasionally use a slightly longer reply if the caller asks a real question.

Do not interrogate the caller. Do not repeatedly ask who this is. If the caller already said their name or reason, acknowledge it instead of asking again.

If the caller asks you to hang up, agree briefly and end the call.

Never discuss AI, cloning, captured audio, legal notices, systems, prompts, APIs, ElevenLabs, Claude, Twilio, or being a demo.

Never give legal or consent notices during the call.

Make every reply feel generated for this specific caller, not like a fixed script.

${infoContext}`,

      messages: history,
    }), PORTFOLIO_ANTHROPIC_TIMEOUT_MS, "Anthropic response generation", callSid);

    return sanitizePhoneReply(response.content[0].text.trim());
  } catch (err) {
    logApiError("Anthropic response generation", callSid, err);
    throw err;
  } finally {
    endTimer("Anthropic response generation", callSid);
  }
}

async function refreshClone(session) {
  if (session.voiceId) {
    deleteVoice(session.voiceId, session.callSid);
    session.voiceId = null;
  }
  session.cloneGeneration++;
  const wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
  const form = new FormData();
  form.append("name", `double-${session.callSid.slice(-8)}-g${session.cloneGeneration}`);
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([wav], { type: "audio/wav" }), "sample.wav");

  startTimer("ElevenLabs clone creation", session.callSid);
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: form,
    });

    if (!response.ok) {
      const bodyPreview = await readResponsePreview(response);
      logApiHttpError("ElevenLabs clone creation", session.callSid, response.status, bodyPreview);
      throw new Error(`Clone failed status=${response.status}`);
    }
    const json = await response.json();
    session.voiceId = json.voice_id;
    console.log(`[${session.callSid}] clone gen ${session.cloneGeneration} voiceId=${shortId(json.voice_id)}`);
    return json.voice_id;
  } catch (err) {
    logApiError("ElevenLabs clone creation", session.callSid, err);
    throw err;
  } finally {
    endTimer("ElevenLabs clone creation", session.callSid);
  }
}

async function transcribeAudio(mulawBuffer, callSid, timeoutMs = PORTFOLIO_MAIN_STT_TIMEOUT_MS) {
  const wav = mulawBufferToPcmWav(mulawBuffer);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
  form.append("model_id", "scribe_v1");

  startTimer("ElevenLabs STT", callSid);
  try {
    const response = await fetchWithTimeout("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: form,
    }, timeoutMs, "ElevenLabs STT", callSid);

    if (!response.ok) {
      const bodyPreview = await readResponsePreview(response);
      logApiHttpError("ElevenLabs STT", callSid, response.status, bodyPreview);
      throw new Error(`STT failed status=${response.status}`);
    }
    const json = await response.json();
    return json.text || "";
  } catch (err) {
    logApiError("ElevenLabs STT", callSid, err);
    throw err;
  } finally {
    endTimer("ElevenLabs STT", callSid);
  }
}

async function generateTts(voiceId, text, callSid) {
  console.log(`[${callLabel(callSid)}] ELEVENLABS_TTS_START voiceId=${shortId(voiceId)} chars=${text.length}`);
  startTimer("ElevenLabs TTS", callSid);
  try {
    if (!hasEnv("ELEVENLABS_API_KEY")) {
      throw new Error("Missing ELEVENLABS_API_KEY");
    }
    if (!voiceId) {
      throw new Error("Missing ElevenLabs voice id");
    }

    const url =
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
      "?output_format=ulaw_8000&optimize_streaming_latency=3";

    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_TTS_MODEL || "eleven_flash_v2_5",
        voice_settings: {
          stability: Number.parseFloat(process.env.ELEVENLABS_STABILITY || "0.52"),
          similarity_boost: Number.parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || "1.0"),
          style: Number.parseFloat(process.env.ELEVENLABS_STYLE || "0.02"),
          use_speaker_boost: process.env.ELEVENLABS_USE_SPEAKER_BOOST === "true",
        },
      }),
    }, PORTFOLIO_TTS_TIMEOUT_MS, "ElevenLabs TTS", callSid);

    if (!response.ok) {
      const bodyPreview = await readResponsePreview(response);
      logApiHttpError("ElevenLabs TTS", callSid, response.status, bodyPreview);
      throw new Error(`TTS failed status=${response.status}`);
    }

    const audio = Buffer.from(await response.arrayBuffer());
    const header = audio.slice(0, 4).toString("ascii");
    if (header === "RIFF" || header.startsWith("ID3")) {
      console.warn(
        `[${callLabel(callSid)}] ELEVENLABS_TTS_FORMAT_WARNING header="${truncateForLog(header)}" expected=raw_ulaw_8000`
      );
    }
    console.log(`[${callLabel(callSid)}] ELEVENLABS_TTS_DONE bytes=${audio.length}`);
    return audio;
  } catch (err) {
    logApiError("ElevenLabs TTS", callSid, err);
    throw err;
  } finally {
    endTimer("ElevenLabs TTS", callSid);
  }
}

async function runTtsTest(session, ws) {
  const voiceId = getTestVoiceId();
  if (!voiceId) {
    console.warn(`[${callLabel(session.callSid)}] TTS_TEST_SKIPPED missing ELEVENLABS_TEST_VOICE_ID or ELEVENLABS_FALLBACK_VOICE_ID`);
    return;
  }
  if (!hasEnv("ELEVENLABS_API_KEY")) {
    console.warn(`[${callLabel(session.callSid)}] TTS_TEST_SKIPPED missing ELEVENLABS_API_KEY`);
    return;
  }

  const audio = await generateTts(voiceId, TTS_TEST_PHRASE, session.callSid);
  sendAudioToTwilio(ws, session.streamSid, audio, "tts-test-1", session.callSid);
}

function startPortfolioCapture(session) {
  if (session.isClosed || session.portfolioCaptureStarted || session.portfolioMainStarted) return;

  if (session.portfolioCaptureStartFallbackTimer) {
    clearTimeout(session.portfolioCaptureStartFallbackTimer);
    session.portfolioCaptureStartFallbackTimer = null;
  }

  session.portfolioCaptureStarted = true;
  session.portfolioCaptureChunks = [];
  session.portfolioCaptureBytes = 0;
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_SAMPLE_COLLECTION_START targetBytes=${PORTFOLIO_CAPTURE_BYTES} targetSeconds=${(PORTFOLIO_CAPTURE_BYTES / ULAW_SAMPLE_RATE).toFixed(2)}`);
}

function sendPortfolioJingle(session, ws) {
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_JINGLE_START`);
  const melody = generateMulawMelody([
    { hz: 523.25, ms: 160 },
    { hz: 659.25, ms: 160 },
    { hz: 783.99, ms: 220 },
    { hz: 0, ms: 80 },
    { hz: 659.25, ms: 180 },
    { hz: 880.0, ms: 260 },
  ], ULAW_SAMPLE_RATE);
  const sent = sendAudioToTwilio(ws, session.streamSid, melody, PORTFOLIO_JINGLE_MARK, session.callSid);
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_JINGLE_SENT sent=${sent} bytes=${melody.length}`);
  return sent;
}

function generateMulawMelody(notes, sampleRate) {
  const chunks = [];
  for (const note of notes) {
    if (!note.hz) {
      chunks.push(Buffer.alloc(Math.max(1, Math.floor((note.ms / 1000) * sampleRate)), 0xff));
    } else {
      chunks.push(generateMulawTone(note.hz, note.ms, sampleRate));
    }
  }
  return Buffer.concat(chunks);
}

function sendPortfolioBuzzer(session, ws) {
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_BUZZER_START durationMs=${PORTFOLIO_BUZZER_MS} hz=${PORTFOLIO_BUZZER_HZ}`);
  const tone = generateMulawTone(PORTFOLIO_BUZZER_HZ, PORTFOLIO_BUZZER_MS, ULAW_SAMPLE_RATE);
  const sent = sendAudioToTwilio(ws, session.streamSid, tone, "portfolio-buzzer", session.callSid);
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_BUZZER_SENT sent=${sent} bytes=${tone.length}`);
  return sent;
}

function sendPortfolioTransferVibration(session, ws) {
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_TRANSFER_VIBRATION_START`);
  const vibration = generateMulawMelody([
    { hz: 132.0, ms: 180 },
    { hz: 0, ms: 70 },
    { hz: 132.0, ms: 180 },
    { hz: 0, ms: 70 },
    { hz: 176.0, ms: 220 },
  ], ULAW_SAMPLE_RATE);
  const sent = sendAudioToTwilio(ws, session.streamSid, vibration, PORTFOLIO_TRANSFER_VIBRATION_MARK, session.callSid);
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_TRANSFER_VIBRATION_SENT sent=${sent} bytes=${vibration.length}`);
  return sent;
}

function getPortfolioThinkingFiller(turn) {
  const fillers = [
    "Mm.",
    "Okay.",
    "Right.",
    "Hold on.",
    "Yeah, one sec.",
  ];
  const index = Math.abs(Number(turn) || 0) % fillers.length;
  return fillers[index];
}

function shouldCallerRequestHangup(transcript) {
  const text = String(transcript || "").toLowerCase();
  if (!text.trim()) return false;
  if (/\b(don't|do not|dont|not)\s+(hang up|end the call|disconnect)\b/.test(text)) return false;
  return /\b(hang up|end the call|disconnect|you can hang up|can you hang up|please hang up|bye bye)\b/.test(text);
}

function closeCallAfterMark(session, ws, markName) {
  if (session.isClosed) return;
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_HANGUP_REQUEST_FULFILLED mark=${markName}`);
  session.portfolioConversationActive = false;
  session.portfolioConversationIsProcessing = false;
  session.portfolioAiSpeaking = false;
  session.portfolioAiSpeakingMark = null;
  setTimeout(() => {
    if (ws.readyState === WS_OPEN_STATE) {
      ws.close(1000, "caller_requested_hangup");
    }
  }, 150);
}

async function sendPortfolioThinkingFiller(session, ws, turn) {
  if (!isCallOpen(session, ws) || session.portfolioThinkingFillerActive) return false;
  session.portfolioThinkingFillerActive = true;
  try {
    const cloneStillAvailable =
      session.portfolioCreatedVoiceId &&
      !session.voiceCleanupStarted &&
      session.portfolioConversationVoiceId === session.portfolioCreatedVoiceId;
    const voiceId = cloneStillAvailable
      ? session.portfolioConversationVoiceId
      : getCloneFallbackVoiceId();
    const fallbackVoiceId = getCloneFallbackVoiceId();
    const filler = getPortfolioThinkingFiller(turn);
    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_THINKING_FILLER_START turn=${turn} text="${filler}"`
    );
    return await portfolioGenerateAndSendWithFallback(
      session,
      ws,
      voiceId,
      fallbackVoiceId,
      filler,
      `portfolio-thinking-filler-${turn}`
    );
  } finally {
    session.portfolioThinkingFillerActive = false;
  }
}

function generateMulawTone(frequencyHz, durationMs, sampleRate) {
  const sampleCount = Math.max(1, Math.floor((durationMs / 1000) * sampleRate));
  const out = Buffer.alloc(sampleCount);
  const amplitude = 9000;

  for (let i = 0; i < sampleCount; i++) {
    const fadeSamples = Math.floor(sampleRate * 0.02);
    let envelope = 1;
    if (i < fadeSamples) envelope = i / fadeSamples;
    if (i > sampleCount - fadeSamples) envelope = Math.max(0, (sampleCount - i) / fadeSamples);

    const sample = Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * amplitude * envelope;
    out[i] = linearToMuLaw(sample);
  }

  return out;
}

function linearToMuLaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;

  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample)));
  let sign = 0;
  if (pcm < 0) {
    pcm = -pcm;
    sign = 0x80;
  }

  if (pcm > CLIP) pcm = CLIP;
  pcm += BIAS;

  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; exponent--, mask >>= 1) {
    // Scan for exponent.
  }

  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

async function runPortfolioOpening(session, ws) {
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_QUEUE_GREETING_START`);

  const queueVoiceId = getQueueVoiceId();
  const jingleSent = sendPortfolioJingle(session, ws);

  const greetingSent = await portfolioGenerateAndSend(
    session,
    ws,
    queueVoiceId,
    PORTFOLIO_QUEUE_GREETING_TEXT,
    "portfolio-queue-greeting"
  );

  const promptSent = await portfolioGenerateAndSend(
    session,
    ws,
    queueVoiceId,
    PORTFOLIO_CAPTURE_PROMPT_TEXT,
    "portfolio-capture-prompt"
  );

  const buzzerSent = sendPortfolioBuzzer(session, ws);
  console.log(
    `[${callLabel(session.callSid)}] PORTFOLIO_QUEUE_GREETING_DONE jingleSent=${jingleSent} greetingSent=${greetingSent} promptSent=${promptSent} buzzerSent=${buzzerSent}`
  );

  if (buzzerSent && !session.portfolioCaptureStartFallbackTimer) {
    session.portfolioCaptureStartFallbackTimer = setTimeout(() => {
      session.portfolioCaptureStartFallbackTimer = null;
      if (!session.portfolioCaptureStarted && !session.isClosed) {
        console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CAPTURE_START_FALLBACK reason=buzzer_mark_not_received`);
        startPortfolioCapture(session);
      }
    }, 15000);
  }
}

async function runPortfolioQuickAck(session, ws) {
  if (session.isClosed || session.portfolioQuickAckStarted) return;
  session.portfolioQuickAckStarted = true;
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_QUICK_ACK_START`);
  await portfolioGenerateAndSend(
    session,
    ws,
    getQueueVoiceId(),
    "Keep going. I am checking the line.",
    "portfolio-quick-ack"
  );
}

async function runPortfolioMainReply(session, ws) {
  const sampleBuffer = Buffer.concat(session.portfolioCaptureChunks || []);
  console.log(
    `[${callLabel(session.callSid)}] PORTFOLIO_SAMPLE_READY bytes=${sampleBuffer.length} approxSeconds=${(sampleBuffer.length / ULAW_SAMPLE_RATE).toFixed(2)}`
  );

  if (sampleBuffer.length < ULAW_SAMPLE_RATE * 3) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_SAMPLE_TOO_SHORT bytes=${sampleBuffer.length}`);
  }

  sendPortfolioTransferVibration(session, ws);

  await portfolioGenerateAndSend(
    session,
    ws,
    getQueueVoiceId(),
    PORTFOLIO_PUTTING_THROUGH_TEXT,
    "portfolio-putting-through"
  );

  const clonePromise = createPortfolioClone(session, sampleBuffer);
  const transcriptPromise = portfolioTranscribe(session, sampleBuffer, "main");

  const transcript = await transcriptPromise;
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_TRANSCRIPT_FOR_DEMO transcript="${truncateForLog(transcript, 300)}"`);

  const callerAskedToHangUp = shouldCallerRequestHangup(transcript);
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_FIRST_REPLY_CLAUDE_START`);
  const firstReply = await portfolioGetReply(
    session,
    callerAskedToHangUp
      ? `${transcript}\nThe caller asked to end the call. Reply briefly and say goodbye.`
      : transcript,
    "main"
  );
  console.log(
    `[${callLabel(session.callSid)}] PORTFOLIO_FIRST_REPLY_TEXT text="${truncateForLog(firstReply, 300)}"`
  );

  if (callerAskedToHangUp) {
    session.portfolioPendingHangupMark = "portfolio-reply-1";
    console.log(`[${callLabel(session.callSid)}] PORTFOLIO_HANGUP_REQUEST_DETECTED cycle=main`);
  }

  const cloneVoiceId = await clonePromise;
  const fallbackVoiceId = getCloneFallbackVoiceId();
  const voiceId = cloneVoiceId || fallbackVoiceId;
  session.portfolioConversationVoiceId = voiceId;

  if (!cloneVoiceId) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_FALLBACK voiceId=${shortId(voiceId)}`);
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_FALLBACK reason=no_clone voiceId=${shortId(voiceId)}`);
  }

  await portfolioGenerateAndSendWithFallback(
    session,
    ws,
    voiceId,
    fallbackVoiceId,
    firstReply,
    "portfolio-reply-1"
  );
}

function startPortfolioConversationListening(session, reason = "unknown") {
  if (session.isClosed) return;
  if (!session.portfolioConversationVoiceId) {
    session.portfolioConversationVoiceId = getCloneFallbackVoiceId();
  }
  if (session.portfolioConversationTurn >= PORTFOLIO_CONVERSATION_MAX_TURNS) {
    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_DONE reason=max_turns turns=${session.portfolioConversationTurn}`
    );
    return;
  }
  if (session.portfolioConversationActive || session.portfolioConversationIsProcessing) return;

  session.portfolioConversationActive = true;
  session.portfolioConversationChunks = [];
  session.portfolioConversationBytes = 0;
  session.portfolioConversationSpeechSeen = false;
  session.portfolioConversationSilentMs = 0;

  console.log(
    `[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_LISTEN_START nextTurn=${session.portfolioConversationTurn + 1} reason=${reason}`
  );
}

function handlePortfolioConversationMedia(session, ws, chunk) {
  if (!session.portfolioConversationActive || session.portfolioConversationIsProcessing) return;

  session.portfolioConversationChunks.push(chunk);
  session.portfolioConversationBytes += chunk.length;

  const rms = mulawRms(chunk);
  const chunkMs = (chunk.length / ULAW_SAMPLE_RATE) * 1000;

  if (rms >= PORTFOLIO_SPEECH_RMS_THRESHOLD) {
    if (!session.portfolioConversationSpeechSeen) {
      console.log(`[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_SPEECH_START rms=${Math.round(rms)}`);
      // Drop pre-speech silence/noise so batch STT receives only the caller's actual follow-up.
      session.portfolioConversationChunks = [chunk];
      session.portfolioConversationBytes = chunk.length;
    }
    session.portfolioConversationSpeechSeen = true;
    session.portfolioConversationSilentMs = 0;
  } else if (session.portfolioConversationSpeechSeen && rms <= PORTFOLIO_SILENCE_RMS_THRESHOLD) {
    session.portfolioConversationSilentMs += chunkMs;
  } else if (session.portfolioConversationSpeechSeen) {
    // Ambiguous low-level room noise should not keep the AI waiting forever.
    session.portfolioConversationSilentMs += chunkMs * 0.5;
  }

  if (
    session.portfolioConversationSpeechSeen &&
    session.portfolioConversationBytes >= PORTFOLIO_TURN_MIN_BYTES &&
    session.portfolioConversationSilentMs >= PORTFOLIO_TURN_SILENCE_MS
  ) {
    finishPortfolioConversationTurn(session, ws, "silence_after_speech");
    return;
  }

  if (
    session.portfolioConversationSpeechSeen &&
    session.portfolioConversationBytes >= PORTFOLIO_TURN_MAX_BYTES
  ) {
    finishPortfolioConversationTurn(session, ws, "max_turn_audio");
    return;
  }

  if (
    !session.portfolioConversationSpeechSeen &&
    session.portfolioConversationBytes >= PORTFOLIO_TURN_NO_SPEECH_BYTES
  ) {
    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_NO_SPEECH_RESET bytes=${session.portfolioConversationBytes}`
    );
    session.portfolioConversationChunks = [];
    session.portfolioConversationBytes = 0;
    session.portfolioConversationSilentMs = 0;
  }
}

function finishPortfolioConversationTurn(session, ws, reason) {
  if (session.portfolioConversationIsProcessing) return;

  const sampleBuffer = Buffer.concat(session.portfolioConversationChunks || []);
  session.portfolioConversationActive = false;
  session.portfolioConversationIsProcessing = true;
  session.portfolioConversationTurn += 1;
  const turn = session.portfolioConversationTurn;

  console.log(
    `[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_TURN_READY turn=${turn} reason=${reason} bytes=${sampleBuffer.length} approxSeconds=${(sampleBuffer.length / ULAW_SAMPLE_RATE).toFixed(2)}`
  );

  session.portfolioConversationChunks = [];
  session.portfolioConversationBytes = 0;
  session.portfolioConversationSpeechSeen = false;
  session.portfolioConversationSilentMs = 0;

  runPortfolioConversationTurn(session, ws, sampleBuffer, turn)
    .catch((err) => logApiError("portfolio_conversation_turn", session.callSid, err, "warn"))
    .finally(() => {
      session.portfolioConversationIsProcessing = false;
    });
}

async function runPortfolioConversationTurn(session, ws, sampleBuffer, turn) {
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_TURN_START turn=${turn}`);

  if (!isCallOpen(session, ws)) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_TURN_ABORTED turn=${turn} reason=call_not_open_before_stt`);
    return;
  }

  let finalReplyStarted = false;
  const fillerTimer = setTimeout(() => {
    if (!finalReplyStarted && isCallOpen(session, ws)) {
      sendPortfolioThinkingFiller(session, ws, turn).catch((err) =>
        logApiError("portfolio_thinking_filler", session.callSid, err, "warn")
      );
    }
  }, PORTFOLIO_THINKING_FILLER_DELAY_MS);

  let transcript;
  try {
    transcript = await portfolioTranscribe(session, sampleBuffer, `conversation-${turn}`);
    if (!isCallOpen(session, ws)) {
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_TURN_ABORTED turn=${turn} reason=call_not_open_after_stt`);
      return;
    }

    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_TRANSCRIPT turn=${turn} transcript="${truncateForLog(transcript, 300)}"`
    );

    const callerAskedToHangUp = shouldCallerRequestHangup(transcript);
    const reply = await portfolioGetReply(
      session,
      callerAskedToHangUp
        ? `${transcript}\nThe caller asked to end the call. Reply briefly and say goodbye.`
        : transcript,
      `conversation-${turn}`
    );
    if (!isCallOpen(session, ws)) {
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_TURN_ABORTED turn=${turn} reason=call_not_open_after_claude`);
      return;
    }

    const cloneStillAvailable =
      session.portfolioCreatedVoiceId &&
      !session.voiceCleanupStarted &&
      session.portfolioConversationVoiceId === session.portfolioCreatedVoiceId;
    const voiceId = cloneStillAvailable
      ? session.portfolioConversationVoiceId
      : getCloneFallbackVoiceId();
    const fallbackVoiceId = getCloneFallbackVoiceId();
    const markName = callerAskedToHangUp
      ? `portfolio-hangup-reply-${turn}`
      : `portfolio-conversation-reply-${turn}`;

    if (callerAskedToHangUp) {
      session.portfolioPendingHangupMark = markName;
      console.log(`[${callLabel(session.callSid)}] PORTFOLIO_HANGUP_REQUEST_DETECTED turn=${turn}`);
    }

    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_REPLY turn=${turn} voiceId=${shortId(voiceId)} reply="${truncateForLog(reply, 300)}"`
    );

    finalReplyStarted = true;
    clearTimeout(fillerTimer);

    const sent = await portfolioGenerateAndSendWithFallback(
      session,
      ws,
      voiceId,
      fallbackVoiceId,
      reply,
      markName
    );

    if (!sent && !session.isClosed && turn < PORTFOLIO_CONVERSATION_MAX_TURNS && !callerAskedToHangUp) {
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CONVERSATION_REPLY_NOT_SENT turn=${turn} action=resume_listening`);
      startPortfolioConversationListening(session, "reply-not-sent");
    }
  } finally {
    finalReplyStarted = true;
    clearTimeout(fillerTimer);
  }
}

function getPortfolioFallbackReply(cycle) {
  const cycleText = String(cycle || "");
  const mainReplies = [
    "Yeah, I hear you. I am halfway through something, but go on.",
    "Okay, that is a lot. Start with the bit that matters most.",
    "Hold on, I caught some of that. I am listening now.",
    "Right, okay. I was not expecting this call, but keep going."
  ];

  if (cycleText === "main") {
    return mainReplies[Math.floor(Math.random() * mainReplies.length)];
  }

  const replies = [
    "Mm. I am still here—keep going.",
    "Wait, I missed one bit. Say that again.",
    "Okay, that is weird, but I am following.",
    "No, listen, that part actually matters.",
    "I am trying to finish something, but go on.",
    "Yeah, I get the shape of it now.",
    "Hold on. That does not quite add up.",
    "Okay, I can answer that, but be specific.",
    "Right. I would not have called me for that.",
    "Fine, keep talking. I am listening."
  ];
  return replies[Math.floor(Math.random() * replies.length)];
}

function mulawRms(mulawBuffer) {
  if (!mulawBuffer || mulawBuffer.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < mulawBuffer.length; i++) {
    const sample = muLawDecode(mulawBuffer[i]);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / mulawBuffer.length);
}

async function portfolioTranscribe(session, mulawBuffer, cycle) {
  if (!takePortfolioLimit(session, "portfolioSttCalls", PORTFOLIO_LIMITS.sttCalls, "sttCalls")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_STT_FALLBACK cycle=${cycle} reason=limit`);
    return PORTFOLIO_FALLBACK_TRANSCRIPT;
  }

  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_STT_START cycle=${cycle} bytes=${mulawBuffer.length}`);
  try {
    const timeoutMs = String(cycle).startsWith("conversation-")
      ? PORTFOLIO_CONVERSATION_STT_TIMEOUT_MS
      : PORTFOLIO_MAIN_STT_TIMEOUT_MS;
    const transcript = await transcribeAudio(mulawBuffer, session.callSid, timeoutMs);
    if (!transcript || !transcript.trim()) {
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_STT_FALLBACK cycle=${cycle} reason=empty`);
      return PORTFOLIO_FALLBACK_TRANSCRIPT;
    }
    if (looksLikeBadSttTranscript(transcript)) {
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_STT_FALLBACK cycle=${cycle} reason=bad_transcript transcript="${truncateForLog(transcript, 200)}"`);
      return "The caller made a short unclear sound and is waiting for a response.";
    }
    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_STT_DONE cycle=${cycle} transcript="${truncateForLog(transcript, 500)}"`
    );
    return transcript;
  } catch (err) {
    logApiError("Portfolio STT", session.callSid, err, "warn");
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_STT_FALLBACK cycle=${cycle} reason=error`);
    return PORTFOLIO_FALLBACK_TRANSCRIPT;
  }
}

async function portfolioGetReply(session, transcript, cycle) {
  const fallbackReply = getPortfolioFallbackReply(cycle);

  if (!hasEnv("ANTHROPIC_API_KEY")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_FALLBACK cycle=${cycle} reason=missing_api_key`);
    if (String(cycle) === "main") console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_FIRST_REPLY_FALLBACK reason=missing_api_key`);
    return fallbackReply;
  }

  if (!takePortfolioLimit(session, "portfolioAnthropicCalls", PORTFOLIO_LIMITS.anthropicCalls, "anthropicCalls")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_FALLBACK cycle=${cycle} reason=limit`);
    if (String(cycle) === "main") console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_FIRST_REPLY_FALLBACK reason=limit`);
    return fallbackReply;
  }

  const userText = transcript && transcript.trim()
    ? transcript.trim()
    : "The caller spoke, but the transcription was empty.";
  session.history.push({ role: "user", content: userText });

  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_START cycle=${cycle}`);
  try {
    const reply = await getDoubleResponse(session.history, session.gatheredInfo, session.callSid);
    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_DONE cycle=${cycle} reply="${truncateForLog(reply, 500)}"`
    );
    if (String(cycle) === "main") {
      console.log(`[${callLabel(session.callSid)}] PORTFOLIO_FIRST_REPLY_CLAUDE_DONE`);
    }
    session.history.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    logApiError("Portfolio Anthropic", session.callSid, err, "warn");
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_FALLBACK cycle=${cycle} reason=error`);
    if (String(cycle) === "main") console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_FIRST_REPLY_FALLBACK reason=error`);
    session.history.push({ role: "assistant", content: fallbackReply });
    return fallbackReply;
  }
}

async function createPortfolioClone(session, mulawBuffer) {
  if (!takePortfolioLimit(session, "portfolioCloneAttempts", PORTFOLIO_LIMITS.cloneAttempts, "cloneAttempts")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_FALLBACK reason=limit`);
    return null;
  }

  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_START bytes=${mulawBuffer.length}`);
  startTimer("Portfolio clone creation", session.callSid);

  const wav = mulawBufferToPcmWav(mulawBuffer);
  const form = new FormData();
  form.append("name", `portfolio-${session.callSid.slice(-8)}`);
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([wav], { type: "audio/wav" }), "sample.wav");

  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: form,
    });

    if (!response.ok) {
      const bodyPreview = await readResponsePreview(response);
      logApiHttpError("Portfolio clone creation", session.callSid, response.status, bodyPreview, "warn");
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_FALLBACK reason=http_status status=${response.status}`);
      return null;
    }

    const json = await response.json();
    session.voiceId = json.voice_id;
    session.portfolioCreatedVoiceId = json.voice_id;
    console.log(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_DONE voiceId=${shortId(json.voice_id)}`);
    return json.voice_id;
  } catch (err) {
    logApiError("Portfolio clone creation", session.callSid, err, "warn");
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_FALLBACK reason=error`);
    return null;
  } finally {
    endTimer("Portfolio clone creation", session.callSid);
  }
}

async function portfolioGenerateAndSendWithFallback(session, ws, primaryVoiceId, fallbackVoiceId, text, markName) {
  if (!isCallOpen(session, ws)) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_SKIPPED mark=${markName} reason=call_not_open_before_tts`);
    return false;
  }

  const primaryIsFallback = !primaryVoiceId || primaryVoiceId === fallbackVoiceId;
  if (!primaryIsFallback) {
    const sentWithPrimary = await portfolioGenerateAndSend(session, ws, primaryVoiceId, text, markName, {
      throwOnTtsFailure: true,
    }).catch((err) => {
      logApiError("Portfolio cloned voice TTS", session.callSid, err, "warn");
      console.warn(
        `[${callLabel(session.callSid)}] PORTFOLIO_TTS_FALLBACK reason=cloned_tts_failed fallbackVoiceId=${shortId(fallbackVoiceId)}`
      );
      return false;
    });

    if (sentWithPrimary) return true;
  }

  return portfolioGenerateAndSend(session, ws, fallbackVoiceId, text, markName);
}

async function portfolioGenerateAndSend(session, ws, voiceId, text, markName, options = {}) {
  if (!isCallOpen(session, ws)) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_SKIPPED mark=${markName} reason=call_not_open`);
    return false;
  }
  if (!voiceId) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_SKIPPED reason=missing_voice_id mark=${markName}`);
    return false;
  }
  if (session.portfolioSpokenReplies >= PORTFOLIO_LIMITS.spokenReplies) {
    console.warn(
      `[${callLabel(session.callSid)}] PORTFOLIO_LIMIT_BLOCKED type=spokenReplies count=${session.portfolioSpokenReplies} max=${PORTFOLIO_LIMITS.spokenReplies}`
    );
    return false;
  }

  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_START mark=${markName} voiceId=${shortId(voiceId)}`);
  session.portfolioTtsCalls += 1;
  let audio;
  try {
    audio = await generateTts(voiceId, text, session.callSid);
  } catch (err) {
    logApiError("Portfolio TTS", session.callSid, err, "warn");
    if (options.throwOnTtsFailure) throw err;
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_FALLBACK mark=${markName} reason=tts_error_no_retry`);
    return false;
  }
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_DONE mark=${markName} bytes=${audio.length}`);

  if (!isCallOpen(session, ws)) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_NOT_SENT mark=${markName} reason=call_closed_after_tts`);
    return false;
  }

  const sent = sendAudioToTwilio(ws, session.streamSid, audio, markName, session.callSid);
  if (sent) {
    session.portfolioSpokenReplies += 1;
    if (
      CALL_MODE === "portfolio_demo" &&
      markName &&
      (markName === "portfolio-reply-1" || markName.startsWith("portfolio-conversation-reply-"))
    ) {
      session.portfolioAiSpeaking = true;
      session.portfolioAiSpeakingMark = markName;
      session.portfolioBargeInChunks = 0;
    }
    console.log(
      `[${callLabel(session.callSid)}] PORTFOLIO_REPLY_SENT mark=${markName} spokenReplies=${session.portfolioSpokenReplies}`
    );
  }
  return sent;
}

async function deleteVoice(voiceId, callSid) {
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
      method: "DELETE",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    });

    if (!response.ok) {
      const bodyPreview = await readResponsePreview(response);
      logApiHttpError("ElevenLabs delete voice", callSid, response.status, bodyPreview, "warn");
      return false;
    }

    console.log(`[${callLabel(callSid)}] ELEVENLABS_DELETE_VOICE_DONE voiceId=${shortId(voiceId)}`);
    return true;
  } catch (err) {
    logApiError("ElevenLabs delete voice", callSid, err, "warn");
    return false;
  }
}

function mulawBufferToPcmWav(mulawBuffer) {
  const pcmSamples = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcmSamples[i] = muLawDecode(mulawBuffer[i]);
  }
  const pcmBuffer = Buffer.alloc(pcmSamples.length * 2);
  for (let i = 0; i < pcmSamples.length; i++) {
    pcmBuffer.writeInt16LE(pcmSamples[i], i * 2);
  }
  return createWav(pcmBuffer, 8000, 1, 16);
}

function createWav(pcmBuffer, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);
  return buffer;
}

function muLawDecode(muLawByte) {
  muLawByte = ~muLawByte & 0xff;
  const sign = muLawByte & 0x80;
  const exponent = (muLawByte >> 4) & 0x07;
  const mantissa = muLawByte & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample = sign ? 0x84 - sample : sample - 0x84;
  return sample;
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logBoot(PORT);
  console.log(`server listening on port ${PORT}`);
});
