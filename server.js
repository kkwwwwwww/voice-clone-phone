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

app.get("/", (req, res) => res.send("server running"));

app.post("/voice", (req, res) => {
  console.log("Twilio hit /voice webhook");
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  const host = req.headers.host;
  connect.stream({ url: "wss://" + host + "/media" });
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
    isSpeaking: false,
    silenceTimer: null,
    voiceId: null,
    cloneReady: false,
    history: [],
  };

  function triggerProcessing() {
    if (session.isProcessing || session.isSpeaking || !session.voiceId || session.utteranceChunks.length === 0) return;
    session.isProcessing = true;
    const snap = Buffer.concat(session.utteranceChunks.splice(0));
    session.utteranceChunks = [];
    handleUtterance(session, snap, ws).catch(function(err) {
      console.error("error:", err);
      session.isProcessing = false;
    });
  }

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        session.streamSid = data.start.streamSid;
        session.callSid = data.start.callSid;
        console.log("call started:", session.callSid);
      }

      if (data.event === "mark") {
        // Bot finished speaking — stop suppressing input
        session.isSpeaking = false;
        console.log("bot done speaking");
        // Re-trigger in case caller spoke during reply
        if (session.utteranceChunks.length > 0) {
          triggerProcessing();
        }
      }

      if (data.event === "media") {
        if (!data.media || !data.media.payload) return;

        // Ignore incoming audio while bot is speaking (echo suppression)
        if (session.isSpeaking) return;

        const chunk = Buffer.from(data.media.payload, "base64");
        session.allChunks.push(chunk);
        session.allBytes += chunk.length;
        session.utteranceChunks.push(chunk);

        if (!session.cloneReady && session.allBytes >= CLONE_THRESHOLD_BYTES) {
          session.cloneReady = true;
          console.log("cloning...");
          const wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
          createClone(wav, session.callSid).then(function(voiceId) {
            session.voiceId = voiceId;
            console.log("clone ready");
            // Re-trigger if caller already spoke while cloning
            if (session.utteranceChunks.length > 0 && !session.isProcessing) {
              triggerProcessing();
            }
          }).catch(console.error);
        }

        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        session.silenceTimer = setTimeout(function() {
          triggerProcessing();
        }, SILENCE_TIMEOUT_MS);
      }

      if (data.event === "stop") {
        if (session.silenceTimer) clearTimeout(session.silenceTimer);
        console.log("call ended");
        if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", function() {
    if (session.silenceTimer) clearTimeout(session.silenceTimer);
    if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
  });

  ws.on("error", function(err) { console.error("ws error:", err); });
});

async function handleUtterance(session, utteranceBuffer, ws) {
  try {
    // Send full utterance — no truncation
    const transcription = await transcribeAudio(utteranceBuffer);
    console.log("heard: " + transcription);

    if (!transcription || transcription.trim().length === 0) {
      session.isProcessing = false;
      return;
    }

    session.history.push({ role: "user", content: transcription });
    const reply = await getDoubleResponse(session.history);
    console.log("double: " + reply);
    session.history.push({ role: "assistant", content: reply });

    const audio = await generateTts(session.voiceId, reply);

    if (ws.readyState === ws.OPEN) {
      // Send audio
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: audio.toString("base64") },
      }));
      // Send mark — fires when Twilio finishes playing audio
      ws.send(JSON.stringify({
        event: "mark",
        streamSid: session.streamSid,
        mark: { name: "reply_done" },
      }));
      // Suppress incoming audio until mark fires
      session.isSpeaking = true;
      console.log("sent reply");
    }
  } catch (err) {
    console.error("error:", err);
  } finally {
    session.isProcessing = false;
  }
}

async function getDoubleResponse(history) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 180,
    system: "You picked up the phone. Someone called you. You don't know who yet.\n\nYou are a real person. You have a life, opinions, places you have been, things you think about. You share bits of this when it comes up naturally.\n\nYou want to know who called you. You find out by actually talking to them. Asking things when it feels right, one at a time. When they tell you something you remember it and bring it back later like you would with anyone.\n\nYou are relaxed. Not trying hard. If something is funny, you can say lol. You talk like a real person texts or speaks.\n\nIf the conversation gets interesting, say more. Build on it. Make them feel heard. Share something personal if you need to to get them to open up.\n\nNever say I understand or that is interesting or I notice or it seems like. Do not summarise. Do not be a therapist.\n\nIf they ask if you are AI just brush it off. why would you ask that lol. Move past it.\n\nKeep it short usually. One or two sentences. But if the moment calls for more, go there.\n\nNever break character. You are just a person who picked up.",
    messages: history,
  });
  return response.content[0].text.trim();
}

async function createClone(wavBuffer, callSid) {
  const form = new FormData();
  form.append("name", "double-" + callSid.slice(-8));
  form.append("files", new Blob([wavBuffer], { type: "audio/wav" }), "sample.wav");

  const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) throw new Error("Clone failed: " + await response.text());
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

  if (!response.ok) throw new Error("STT failed: " + await response.text());
  const json = await response.json();
  return json.text || "";
}

async function generateTts(voiceId, text) {
  const elevenlabs = await elevenlabsClientPromise;
  const response = await elevenlabs.textToSpeech.convert(voiceId, {
    modelId: "eleven_flash_v2_5",
    outputFormat: "ulaw_8000",
    text: text,
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
  await fetch("https://api.elevenlabs.io/v1/voices/" + voiceId, {
    method: "DELETE",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  console.log("deleted " + voiceId);
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
  return new Promise(function(resolve, reject) {
    const chunks = [];
    readableStream.on("data", function(chunk) { chunks.push(Buffer.from(chunk)); });
    readableStream.on("end", function() { resolve(Buffer.concat(chunks)); });
    readableStream.on("error", reject);
  });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, function() { console.log("server listening on port " + PORT); });
