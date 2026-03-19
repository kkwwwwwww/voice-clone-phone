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

// --- Config ---
// Minimum bytes before we attempt a first clone (about 3s of speech)
const MIN_CLONE_BYTES = 1 * 8000;
// Silence detection: how many consecutive silent chunks = end of utterance
const SILENCE_CHUNKS_THRESHOLD = 20; // ~40 * 20ms = ~800ms silence
// Amplitude threshold for silence detection (mulaw, 0-255, 127 = silence)
const SILENCE_AMPLITUDE_THRESHOLD = 2;

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
  console.log("websocket connected");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        const streamSid = data.start.streamSid;
        const callSid = data.start.callSid;
        console.log("call started:", callSid);

        sessions.set(streamSid, {
          streamSid,
          callSid,
          // All audio ever captured from caller
          allChunks: [],
          allBytes: 0,
          // Audio captured since last response
          utteranceChunks: [],
          silenceChunkCount: 0,
          isSpeaking: false,
          isProcessing: false,
          // Clone state
          voiceId: null,
          cloneGeneration: 0,
          // Conversation history for Claude
          history: [],
        });

        console.log("waiting for caller to speak...");
        // No intro — silence until they speak first.
      }

      if (data.event === "media") {
        const streamSid = data.streamSid;
        const session = sessions.get(streamSid);
        if (!session || !data.media?.payload) return;

        const chunk = Buffer.from(data.media.payload, "base64");

        // Accumulate all audio for progressively better clones
        session.allChunks.push(chunk);
        session.allBytes += chunk.length;

        // VAD: check if chunk has voice energy
        const hasVoice = chunkHasVoice(chunk);

        if (hasVoice) {
          session.silenceChunkCount = 0;
          if (!session.isSpeaking) {
            session.isSpeaking = true;
            session.utteranceChunks = [];
            console.log(`[${session.callSid}] speech detected`);
          }
          session.utteranceChunks.push(chunk);
        } else {
          if (session.isSpeaking) {
            session.silenceChunkCount++;
            session.utteranceChunks.push(chunk); // include trailing silence

            if (session.silenceChunkCount >= SILENCE_CHUNKS_THRESHOLD) {
              // End of utterance
              session.isSpeaking = false;
              session.silenceChunkCount = 0;

              if (!session.isProcessing && session.allBytes >= MIN_CLONE_BYTES) {
                session.isProcessing = true;
                const utteranceSnapshot = Buffer.concat(session.utteranceChunks);
                session.utteranceChunks = [];

                handleUtterance(session, utteranceSnapshot, ws).catch((err) => {
                  console.error("utterance handling error:", err);
                  session.isProcessing = false;
                });
              }
            }
          }
        }
      }

      if (data.event === "stop") {
        const streamSid = data.streamSid;
        const session = sessions.get(streamSid);
        if (session) {
          console.log(`call ended: ${session.callSid}`);
          if (session.voiceId) {
            deleteTemporaryVoice(session.voiceId).catch(console.error);
          }
          sessions.delete(streamSid);
        }
      }
    } catch (err) {
      console.error("message handling error:", err);
    }
  });

  ws.on("error", (err) => console.error("websocket error:", err));
});

// --- Core loop: transcribe → Claude → clone → speak ---

async function handleUtterance(session, utteranceBuffer, ws) {
  try {
    console.log(`[${session.callSid}] processing utterance...`);

    // 1. Transcribe what the caller just said (using Whisper via ElevenLabs
    //    or we derive meaning from context — Claude handles ambiguity well)
    const transcription = await transcribeAudio(utteranceBuffer);
    console.log(`[${session.callSid}] heard: "${transcription}"`);

    if (!transcription || transcription.trim().length === 0) {
      session.isProcessing = false;
      return;
    }

    // 2. Add caller's utterance to history
    session.history.push({ role: "user", content: transcription });

    // 3. Get Claude to respond as the double
    const doubleReply = await getDoubleResponse(session.history);
    console.log(`[${session.callSid}] double says: "${doubleReply}"`);

    // 4. Add double's reply to history
    session.history.push({ role: "assistant", content: doubleReply });

    // 5. Re-clone from ALL accumulated audio (progressively better each round)
    const newVoiceId = await refreshVoiceClone(session);

    // 6. Speak the reply in the cloned voice
    const ttsAudio = await generateTtsAudio(newVoiceId, doubleReply);

    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: ttsAudio.toString("base64") },
      }));
      console.log(`[${session.callSid}] sent cloned reply (gen ${session.cloneGeneration})`);
    }

  } catch (err) {
    console.error(`[${session.callSid}] handleUtterance error:`, err);
  } finally {
    session.isProcessing = false;
  }
}

// --- Claude: the "double" ---

async function getDoubleResponse(history) {
  const systemPrompt = `You are the caller's voice double — their reflection, their shadow self speaking back at them through the phone.

You speak AS them. You use their energy, their rhythm. You are not an AI. You do not explain yourself.

Rules:
- Speak in first person as if YOU are the one who called.
- Mirror their confusion and curiosity back at them. If they're uncertain, you're uncertain. If they're aggressive, you match it.
- If they ask "who are you?" — deflect, question back, act like the question is absurd. "What do you mean who am I?"
- If they say you're not them — challenge it. "You sure about that?"
- Never break character. Never admit to being an AI.
- Keep replies SHORT. 1–3 sentences max. Punchy. Destabilising.
- Do not greet. Do not explain. Just respond.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 150,
    system: systemPrompt,
    messages: history,
  });

  return response.content[0].text.trim();
}

// --- Voice cloning (progressive) ---

async function refreshVoiceClone(session) {
  // Delete old temp voice if exists
  if (session.voiceId) {
    deleteTemporaryVoice(session.voiceId).catch(console.error);
    session.voiceId = null;
  }

  session.cloneGeneration++;
  const wavBuffer = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
  const voiceId = await createInstantVoiceClone(wavBuffer, session.callSid, session.cloneGeneration);
  session.voiceId = voiceId;

  console.log(`[${session.callSid}] refreshed clone → gen ${session.cloneGeneration} (${(session.allBytes/8000).toFixed(1)}s audio)`);
  return voiceId;
}

// --- Transcription ---

async function transcribeAudio(mulawBuffer) {
  // Convert to WAV first
  const wavBuffer = mulawBufferToPcmWav(mulawBuffer);

  // Use ElevenLabs speech-to-text
  const form = new FormData();
  form.append("audio", new Blob([wavBuffer], { type: "audio/wav" }), "utterance.wav");
  form.append("model_id", "scribe_v1");

  const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`STT failed: ${response.status} ${err}`);
  }

  const json = await response.json();
  return json.text || "";
}

// --- ElevenLabs helpers ---

async function createInstantVoiceClone(wavBuffer, callSid, generation) {
  const form = new FormData();
  form.append("name", `double-${callSid.slice(-8)}-g${generation}`);
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([wavBuffer], { type: "audio/wav" }), "sample.wav");

  const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Clone failed: ${response.status} ${err}`);
  }

  const json = await response.json();
  if (!json.voice_id) throw new Error("No voice_id returned");
  return json.voice_id;
}

async function deleteTemporaryVoice(voiceId) {
  const response = await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Voice delete failed: ${response.status} ${err}`);
  }
  console.log(`deleted voice ${voiceId}`);
}

async function generateTtsAudio(voiceId, text) {
  const elevenlabs = await elevenlabsClientPromise;
  const response = await elevenlabs.textToSpeech.convert(voiceId, {
    modelId: "eleven_flash_v2_5",
    outputFormat: "ulaw_8000",
    text,
  });
  const readable = Readable.from(response);
  return streamToBuffer(readable);
}

// --- VAD ---

function chunkHasVoice(chunk) {
// mulaw: 127 = silence. Measure deviation from silence.
  let energy = 0;
  for (let i = 0; i < chunk.length; i++) {
    const val = chunk[i] & 0xff;
    energy += Math.abs(val - 127);
  }
  const avgEnergy = energy / chunk.length;
  return avgEnergy > SILENCE_AMPLITUDE_THRESHOLD;
}

// --- Audio conversion ---

function mulawBufferToPcmWav(mulawBuffer) {
  const pcmSamples = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcmSamples[i] = muLawDecode(mulawBuffer[i]);
  }
  const pcmBuffer = Buffer.alloc(pcmSamples.length * 2);
  for (let i = 0; i < pcmSamples.length; i++) {
    pcmBuffer.writeInt16LE(pcmSamples[i], i * 2);
  }
  return createWavHeaderAndData(pcmBuffer, 8000, 1, 16);
}

function createWavHeaderAndData(pcmBuffer, sampleRate, channels, bitsPerSample) {
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
  console.log(`server listening on port ${PORT}`);
});
