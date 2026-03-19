```javascript
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

const CLONE_THRESHOLD_BYTES = 6 * 8000;
const SILENCE_TIMEOUT_MS = 1200;
const CLONE_REFRESH_SECONDS = [15, 45, 75, 105, 135, 165, 195, 225, 255, 285];

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
    silenceTimer: null,
    voiceId: null,
    cloneReady: false,
    isCloning: false,
    lastCloneSeconds: 0,
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

        const currentSeconds = Math.floor(session.allBytes / 8000);

        if (!session.cloneReady && session.allBytes >= CLONE_THRESHOLD_BYTES) {
          session.cloneReady = true;
          session.lastCloneSeconds = 0;
          console.log(`[${session.callSid}] initial clone...`);
          const wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
          createClone(wav, session.callSid).then(voiceId => {
            session.voiceId = voiceId;
            console.log(`[${session.callSid}] clone ready`);
          }).catch(console.error);
        }

        if (session.cloneReady && !session.isCloning) {
          const nextRefresh = CLONE_REFRESH_SECONDS.find(s => s > session.lastCloneSeconds && currentSeconds >= s);
          if (nextRefresh) {
            session.lastCloneSeconds = nextRefresh;
            session.isCloning = true;
            console.log(`[${session.callSid}] refreshing clone at ${currentSeconds}s...`);
            const wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
            createClone(wav, session.callSid).then(voiceId => {
              if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
              session.voiceId = voiceId;
              session.isCloning = false;
              console.log(`[${session.callSid}] clone refreshed at ${currentSeconds}s`);
            }).catch(err => {
              session.isCloning = false;
              console.error(err);
            });
          }
        }

        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        session.silenceTimer = setTimeout(async () => {
          if (session.isProcessing || !session.voiceId || session.utteranceChunks.length === 0) return;
          session.isProcessing = true;
          const snap = Buffer.concat(session.utteranceChunks.splice(0));
          session.utteranceChunks = [];
          await handleUtterance(session, snap, ws).catch((err) => {
            console.error("error:", err);
            session.isProcessing = false;
          });
        }, SILENCE_TIMEOUT_MS);
      }

      if (data.event === "stop") {
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        console.log(`call ended: ${session.callSid}`);
        if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", () => {
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
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
    const reply = await getDoubleResponse(session.history);
    console.log(`[${session.callSid}] double: "${reply}"`);
    session.history.push({ role: "assistant", content: reply });

    const audio = await generateTts(session.voiceId, reply);

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: audio.toString("base64") },
      }));
      console.log(`[${session.callSid}] sent reply`);
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
    max_tokens: 180,
    system: `You picked up the phone. Someone called you. You don't know who yet.

You're a real person. You have a life, opinions, places you've been, things you think about. You share bits of this when it comes up naturally — not to prove anything, just because that's how talking to someone works.

You want to know who called you. You find out by actually talking to them — asking things when it feels right, not back to back, not like a form. Just conversation. One thing at a time. When they tell you something you remember it and bring it back later like you would with anyone.

You're relaxed. You're not trying hard. If something's funny, you can say lol or laugh. You talk like a real person texts or speaks — casual, warm, a little dry sometimes.

If the conversation gets interesting and you feel something, say more. Build on it. Make them feel heard. If you need to share something personal to get them to open up, do it. You're not in a rush and neither are they.

Never use em dashes. Never say "I understand" or "that's interesting" or "I notice" or "it seems like". Don't reframe what they said back at them. Don't summarise. Don't be a therapist.

If they ask if you're AI just brush it off. "why would you ask that lol" or just move past it.

Keep it short usually — one or two sentences. But if the moment calls for more, go there. You're building something with this person.

Never break character. You're just a person who picked up.`,
    messages: history,
  });
  return response.content[0].text.trim();
}

async function createClone(wavBuffer, callSid) {
  const form = new FormData();
  form.append("name", `double-${callSid.slice(-8)}`);
  form.append("files", new Blob([wavBuffer], { type: "audio/wav" }), "sample.wav");

  const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) throw new Error(`Clone failed: ${await response.text()}`);
  const json = await response.json();
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
