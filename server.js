require("dotenv").config({ quiet: true });

const express = require("express");
const http = require("http");
const { Readable } = require("stream");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const elevenlabsClientPromise = import("@elevenlabs/elevenlabs-js").then(
  ({ ElevenLabsClient }) =>
    new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
);

const app = express();
app.use(express.urlencoded({ extended: false }));

const CLONE_THRESHOLD_BYTES = 3 * 8000;
const PROCESS_INTERVAL_MS = 3000;
const MEDIA_STATS_INTERVAL_MS = 5000;
const ULAW_SAMPLE_RATE = 8000;
const API_ERROR_PREVIEW_CHARS = 500;
const VALID_CALL_MODES = new Set(["diagnostic", "tts_test", "full"]);
const RAW_CALL_MODE = process.env.CALL_MODE || "diagnostic";
const CALL_MODE = VALID_CALL_MODES.has(RAW_CALL_MODE) ? RAW_CALL_MODE : "diagnostic";
const TTS_TEST_PHRASE = "This is ElevenLabs audio over Twilio media.";

const sessions = new Map();
const activeTimers = new Map();

function hasEnv(name) {
  return Boolean(process.env[name]);
}

function getTestVoiceId() {
  return process.env.ELEVENLABS_TEST_VOICE_ID || process.env.ELEVENLABS_FALLBACK_VOICE_ID || "";
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
  console.log(`ELEVENLABS_TEST_OR_FALLBACK_VOICE_ID=${getTestVoiceId() ? "present" : "missing"}`);
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

  const closeInfo = extra.code ? ` code=${extra.code} reason="${truncateForLog(extra.reason || "")}"` : "";
  console.log(
    `[${callLabel(session.callSid)}] CALL_${reason.toUpperCase()} streamSid=${session.streamSid || "unknown"} packets=${session.packetCount} bytes=${session.allBytes} approxSeconds=${(session.allBytes / ULAW_SAMPLE_RATE).toFixed(2)}${closeInfo}`
  );

  if (session.streamSid) {
    sessions.delete(session.streamSid);
  }

  if (CALL_MODE === "full" && session.voiceId && !session.voiceCleanupStarted) {
    const voiceId = session.voiceId;
    session.voiceId = null;
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
    if (ws.readyState !== ws.OPEN) {
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

app.post("/voice", (req, res) => {
  const host = req.headers.host;
  console.log(
    `TWILIO_VOICE_HIT timestamp=${new Date().toISOString()} host=${host || "missing"} callMode=${CALL_MODE} CallSid=${req.body.CallSid || "missing"} From=${req.body.From || "missing"} To=${req.body.To || "missing"}`
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
});

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
    const elevenlabs = await elevenlabsClientPromise;
    const response = await elevenlabs.textToSpeech.convert(voiceId, {
      modelId: "eleven_flash_v2_5",
      outputFormat: "ulaw_8000",
      text,
      voiceSettings: {
        stability: 0.3,
        similarityBoost: 0.9,
        style: 0.0,
        useSpeakerBoost: false,
      },
    });
    const audio = await streamToBuffer(Readable.from(response));
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

function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    readableStream.on("end", () => resolve(Buffer.concat(chunks)));
    readableStream.on("error", reject);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logBoot(PORT);
  console.log(`server listening on port ${PORT}`);
});
