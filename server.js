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
  "Thank you for calling. You are currently being held in a priority queue.";
const PORTFOLIO_CAPTURE_PROMPT_TEXT =
  "Before I connect you, please explain the purpose of your call after the tone. This consented demo will process and clone your voice for this call.";
const PORTFOLIO_PUTTING_THROUGH_TEXT = "Thank you. I am putting you through now.";
const PORTFOLIO_FIRST_CLONE_REPLY = "Hey, who's this? Why did you call?";
const PORTFOLIO_FALLBACK_TRANSCRIPT = "The caller is speaking into the phone.";
const PORTFOLIO_FALLBACK_REPLY = "Hey, who's this? Why did you call?";
const PORTFOLIO_CAPTURE_BYTES = 18 * ULAW_SAMPLE_RATE;
const PORTFOLIO_BUZZER_MS = 450;
const PORTFOLIO_BUZZER_HZ = 880;
const WS_OPEN_STATE = 1;
const PORTFOLIO_LIMITS = {
  cloneAttempts: 1,
  sttCalls: 2,
  anthropicCalls: 2,
  spokenReplies: 5,
};

const sessions = new Map();
const activeTimers = new Map();

function hasEnv(name) {
  return Boolean(process.env[name]);
}

function getTestVoiceId() {
  return (
    process.env.ELEVENLABS_TEST_VOICE_ID ||
    process.env.ELEVENLABS_FALLBACK_VOICE_ID ||
    process.env.ELEVENLABS_VOICE_ID ||
    process.env.ELEVENLABS_DEFAULT_VOICE_ID ||
    process.env.FALLBACK_VOICE_ID ||
    process.env.VOICE_ID ||
    ""
  );
}

function getPortfolioMissingEnv() {
  const missing = [];
  if (!hasEnv("ELEVENLABS_API_KEY")) missing.push("ELEVENLABS_API_KEY");
  if (!getTestVoiceId()) {
    missing.push("ELEVENLABS_TEST_VOICE_ID or ELEVENLABS_FALLBACK_VOICE_ID or ELEVENLABS_VOICE_ID");
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

function logBoot(PORT) {
  console.log("APP_STARTED service=voice-clone-phone");
  console.log(`NODE_ENV=${process.env.NODE_ENV || "unset"}`);
  if (!VALID_CALL_MODES.has(RAW_CALL_MODE)) {
    console.warn(`INVALID_CALL_MODE value=${RAW_CALL_MODE} using=diagnostic`);
  }
  console.log(`CALL_MODE=${CALL_MODE}`);
  console.log(`ANTHROPIC_API_KEY=${hasEnv("ANTHROPIC_API_KEY") ? "present" : "missing"}`);
  console.log(`ELEVENLABS_API_KEY=${hasEnv("ELEVENLABS_API_KEY") ? "present" : "missing"}`);
  console.log(`ELEVENLABS_FIXED_VOICE_ID=${getTestVoiceId() ? "present" : "missing"}`);
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
  session.isClosed = true;

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

app.get("/", (req, res) => res.send("server running"));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "voice-clone-phone",
    callMode: CALL_MODE,
    hasAnthropicKey: hasEnv("ANTHROPIC_API_KEY"),
    hasElevenLabsKey: hasEnv("ELEVENLABS_API_KEY"),
    hasFixedVoiceId: Boolean(getTestVoiceId()),
    fixedVoiceIdPreview: shortId(getTestVoiceId()),
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
        console.log(
          `[${callLabel(session.callSid)}] TWILIO_MARK_RECEIVED name=${data.mark?.name || "missing"} sequenceNumber=${data.sequenceNumber ?? "missing"}`
        );

        if (CALL_MODE === "portfolio_demo" && data.mark?.name === "portfolio-buzzer") {
          startPortfolioCapture(session);
        }

        if (CALL_MODE === "portfolio_demo" && data.mark?.name === "portfolio-reply-1") {
          console.log(`[${callLabel(session.callSid)}] PORTFOLIO_MAIN_REPLY_MARK_DONE`);
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
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 80,
      system: `You are on a phone call. You're curious about the person you're speaking to. That's it.

You ask questions the way a person would — casually, one at a time. You listen. You remember what they say and bring it back later naturally, the way anyone would in a real conversation.

Never say things like "I understand" or "that's interesting" or "I notice that". Don't summarise. Don't reflect back analytically. Just talk like a person.

If they say their name, use it later — not immediately, just naturally. If they mention where they're from, reference it like you already knew somehow. Make them feel like you've been paying attention longer than you should have.

Short responses only. One or two sentences. Ask one thing at a time. If there's nothing to ask, just say something small and human — the kind of thing anyone says on a phone call when they're listening.

Never explain yourself. Never describe what you're doing. Just do it.

${infoContext}`,
      messages: history,
    });

    return response.content[0].text.trim();
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

async function transcribeAudio(mulawBuffer, callSid) {
  const wav = mulawBufferToPcmWav(mulawBuffer);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
  form.append("model_id", "scribe_v1");

  startTimer("ElevenLabs STT", callSid);
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
      body: form,
    });

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

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": process.env.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        voice_settings: {
          stability: 0.3,
          similarity_boost: 0.9,
          style: 0.0,
          use_speaker_boost: false,
        },
      }),
    });

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

function sendPortfolioBuzzer(session, ws) {
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_BUZZER_START durationMs=${PORTFOLIO_BUZZER_MS} hz=${PORTFOLIO_BUZZER_HZ}`);
  const tone = generateMulawTone(PORTFOLIO_BUZZER_HZ, PORTFOLIO_BUZZER_MS, ULAW_SAMPLE_RATE);
  const sent = sendAudioToTwilio(ws, session.streamSid, tone, "portfolio-buzzer", session.callSid);
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_BUZZER_SENT sent=${sent} bytes=${tone.length}`);
  return sent;
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

  const greetingSent = await portfolioGenerateAndSend(
    session,
    ws,
    getTestVoiceId(),
    PORTFOLIO_QUEUE_GREETING_TEXT,
    "portfolio-queue-greeting"
  );

  const promptSent = await portfolioGenerateAndSend(
    session,
    ws,
    getTestVoiceId(),
    PORTFOLIO_CAPTURE_PROMPT_TEXT,
    "portfolio-capture-prompt"
  );

  const buzzerSent = sendPortfolioBuzzer(session, ws);
  console.log(
    `[${callLabel(session.callSid)}] PORTFOLIO_QUEUE_GREETING_DONE greetingSent=${greetingSent} promptSent=${promptSent} buzzerSent=${buzzerSent}`
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
    getTestVoiceId(),
    "Keep going. I need a little more of your voice.",
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

  await portfolioGenerateAndSend(
    session,
    ws,
    getTestVoiceId(),
    PORTFOLIO_PUTTING_THROUGH_TEXT,
    "portfolio-putting-through"
  );

  const clonePromise = createPortfolioClone(session, sampleBuffer);
  const transcriptPromise = portfolioTranscribe(session, sampleBuffer, "main");

  const transcript = await transcriptPromise;
  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_TRANSCRIPT_FOR_DEMO transcript="${truncateForLog(transcript, 300)}"`);

  const cloneVoiceId = await clonePromise;
  const voiceId = cloneVoiceId || getTestVoiceId();
  if (!cloneVoiceId) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_CLONE_FALLBACK voiceId=${shortId(voiceId)}`);
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_TTS_FALLBACK reason=no_clone voiceId=${shortId(voiceId)}`);
  }

  await portfolioGenerateAndSendWithFallback(
    session,
    ws,
    voiceId,
    getTestVoiceId(),
    PORTFOLIO_FIRST_CLONE_REPLY,
    "portfolio-reply-1"
  );
}

async function portfolioTranscribe(session, mulawBuffer, cycle) {
  if (!takePortfolioLimit(session, "portfolioSttCalls", PORTFOLIO_LIMITS.sttCalls, "sttCalls")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_STT_FALLBACK cycle=${cycle} reason=limit`);
    return PORTFOLIO_FALLBACK_TRANSCRIPT;
  }

  console.log(`[${callLabel(session.callSid)}] PORTFOLIO_STT_START cycle=${cycle} bytes=${mulawBuffer.length}`);
  try {
    const transcript = await transcribeAudio(mulawBuffer, session.callSid);
    if (!transcript || !transcript.trim()) {
      console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_STT_FALLBACK cycle=${cycle} reason=empty`);
      return PORTFOLIO_FALLBACK_TRANSCRIPT;
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
  if (!hasEnv("ANTHROPIC_API_KEY")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_FALLBACK cycle=${cycle} reason=missing_api_key`);
    return PORTFOLIO_FALLBACK_REPLY;
  }

  if (!takePortfolioLimit(session, "portfolioAnthropicCalls", PORTFOLIO_LIMITS.anthropicCalls, "anthropicCalls")) {
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_FALLBACK cycle=${cycle} reason=limit`);
    return PORTFOLIO_FALLBACK_REPLY;
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
    session.history.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    logApiError("Portfolio Anthropic", session.callSid, err, "warn");
    console.warn(`[${callLabel(session.callSid)}] PORTFOLIO_ANTHROPIC_FALLBACK cycle=${cycle} reason=error`);
    session.history.push({ role: "assistant", content: PORTFOLIO_FALLBACK_REPLY });
    return PORTFOLIO_FALLBACK_REPLY;
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

  const sent = sendAudioToTwilio(ws, session.streamSid, audio, markName, session.callSid);
  if (sent) {
    session.portfolioSpokenReplies += 1;
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
