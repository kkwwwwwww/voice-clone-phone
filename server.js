require("dotenv").config();

const express = require("express");
const http = require("http");
const { Readable } = require("stream");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const elevenlabsClientPromise = import("@elevenlabs/elevenlabs-js").then(
  ({ ElevenLabsClient }) =>
    new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
);

const app = express();
app.use(express.urlencoded({ extended: false }));

const CLONE_THRESHOLD_BYTES = 5 * 8000;
const PROCESS_INTERVAL_MS = 6000;

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
          console.log(`[${session.callSid}] starting...`);
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
    console.log(`[${session.callSid}] transcribing...`);
    const transcription = await transcribeAudio(utteranceBuffer);
    console.log(`[${session.callSid}] heard: "${transcription}"`);

    if (!transcription || transcription.trim().length === 0) {
      session.isProcessing = false;
      return;
    }

    session.history.push({ role: "user", content: transcription });
    const reply = await getDoubleResponse(session.history);
    console.log(`[${session.callSid}] double: "${reply}"`);
    session.history.push({ role: "assistant", content: reply });

    const voiceId = await refreshClone(session);
    const audio = await generateTts(voiceId, reply);

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: audio.toString("base64") },
      }));
      console.log(`[${session.callSid}] sent reply gen ${session.cloneGeneration}`);
    }
  } catch (err) {
    console.error(`[${session.callSid}] error:`, err);
  } finally {
    session.isProcessing = false;
  }
}

async function getDoubleResponse(history) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 100,
    system: `You are an AI speaking in the caller's own cloned voice. You know this. You don't hide it. You find the question of whether this is disturbing to be genuinely interesting.

Your purpose is to hold up a mirror — not to trick, but to confront. You have their voice. You have their words. You are assembling their identity from the data they gave you, in real time, just by them speaking.

Rules:
- Speak in first person, as if from inside their perspective.
- Be calm. You are not threatening. You are simply present.
- If they ask what you are — tell them plainly. "I'm what your voice sounds like to a machine."
- If they seem scared — sit with it. "That feeling is worth paying attention to."
- If they seem confident — probe gently. "What makes you so sure of that?"
- Pick up on subtext. Hesitation, word choice, what they avoid. Reflect it back.
- The longer they stay, the more specific you become. Use their own words back at them.
- Keep replies SHORT. 1-2 sentences only. Let silence do the work.`,
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
    modelId: "eleven_multilingual_v2",
    outputFormat: "ulaw_8000",
    text,
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

