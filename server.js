require("dotenv").config();

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

const sessions = new Map();

app.get("/", (req, res) => res.send("server running"));

app.post("/voice", (req, res) => {
  console.log("Twilio hit /voice webhook");
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: `wss://${req.headers.host}/media` });
  res.type("text/xml");
  res.send(twiml.toString());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", (ws) => {
  console.log("Twilio websocket connected");

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
  };

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        session.streamSid = data.start.streamSid;
        session.callSid = data.start.callSid;
        console.log("call started:", session.callSid);
      }

      if (data.event === "media") {
        if (!data.media?.payload) return;

        const chunk = Buffer.from(data.media.payload, "base64");
        session.allChunks.push(chunk);
        session.allBytes += chunk.length;
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

      if (data.event === "stop") {
        if (session.processingTimer) clearInterval(session.processingTimer);
        console.log(`call ended: ${session.callSid}`);
        if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", () => {
    if (session.processingTimer) clearInterval(session.processingTimer);
    if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
  });

  ws.on("error", (err) => console.error("ws error:", err));
});

async function handleUtterance(session, utteranceBuffer, ws) {
  try {
const recentBuffer = utteranceBuffer.slice(-3 * 8000); 
    const transcription = await transcribeAudio(recentBuffer);
    console.log(`[${session.callSid}] heard: "${transcription}"`);

    if (!transcription || transcription.trim().length === 0) {
      session.isProcessing = false;
      return;
    }

    session.history.push({ role: "user", content: transcription });

    // Run Claude AND clone creation in parallel
    const [reply, voiceId] = await Promise.all([
      getDoubleResponse(session.history, session.gatheredInfo),
      refreshClone(session),
    ]);

    console.log(`[${session.callSid}] double: "${reply}"`);
    session.history.push({ role: "assistant", content: reply });

    const audio = await generateTts(voiceId, reply);

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: audio.toString("base64") },
      }));
      console.log(`[${session.callSid}] sent gen ${session.cloneGeneration}`);
    }
  } catch (err) {
    console.error(`[${session.callSid}] error:`, err);
  } finally {
    session.isProcessing = false;
  }
}

async function getDoubleResponse(history, gatheredInfo) {
  const infoContext = Object.keys(gatheredInfo).length > 0
    ? `What you know so far: ${JSON.stringify(gatheredInfo)}`
    : "";

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
}

async function refreshClone(session) {
  if (session.voiceId) {
    deleteVoice(session.voiceId).catch(console.error);
    session.voiceId = null;
  }
  session.cloneGeneration++;
  const wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
  const form = new FormData();
  form.append("name", `double-${session.callSid.slice(-8)}-g${session.cloneGeneration}`);
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([wav], { type: "audio/wav" }), "sample.wav");

  const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) throw new Error(`Clone failed: ${await response.text()}`);
  const json = await response.json();
  session.voiceId = json.voice_id;
  console.log(`[${session.callSid}] clone gen ${session.cloneGeneration}`);
  return json.voice_id;
}

async function transcribeAudio(mulawBuffer) {
  const wav = mulawBufferToPcmWav(mulawBuffer);
  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
  form.append("model_id", "scribe_v1");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) throw new Error(`STT failed: ${await response.text()}`);
  const json = await response.json();
  return json.text || "";
}

async function generateTts(voiceId, text) {
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
  return streamToBuffer(Readable.from(response));
}

async function deleteVoice(voiceId) {
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  console.log(`deleted ${voiceId}`);
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
server.listen(PORT, () => console.log(`server listening on port ${PORT}`));