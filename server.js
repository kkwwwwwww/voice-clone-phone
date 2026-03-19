require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

// 10 seconds of audio capture before connecting to agent
const CLONE_THRESHOLD_BYTES = 10 * 8000;

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
    cloneCreated: false,
    agentWs: null,
    voiceId: null,
  };

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        session.streamSid = data.start.streamSid;
        session.callSid = data.start.callSid;
        console.log("call started:", session.callSid);
        console.log("collecting voice sample — silence is intentional...");
      }

      if (data.event === "media") {
        if (!data.media?.payload) return;

        const chunk = Buffer.from(data.media.payload, "base64");
        session.allChunks.push(chunk);
        session.allBytes += chunk.length;

        // Forward audio to agent if connected
        if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
          const pcm16000 = mulawToPcm16000(chunk);
          session.agentWs.send(JSON.stringify({
            user_audio_chunk: pcm16000.toString("base64"),
          }));
        }

        // Once we have 10s of audio, create clone and connect agent
        if (!session.cloneCreated && session.allBytes >= CLONE_THRESHOLD_BYTES) {
          session.cloneCreated = true;
          console.log(`[${session.callSid}] 10s captured — creating voice clone...`);

          try {
            const wavBuffer = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
            const voiceId = await createInstantVoiceClone(wavBuffer, session.callSid);
            session.voiceId = voiceId;
            console.log(`[${session.callSid}] clone ready: ${voiceId} — connecting agent...`);
            connectToAgent(session, ws);
          } catch (err) {
            console.error(`[${session.callSid}] clone error:`, err);
          }
        }
      }

      if (data.event === "stop") {
        console.log(`call ended: ${session.callSid}`);
        if (session.agentWs) session.agentWs.close();
        if (session.voiceId) deleteTemporaryVoice(session.voiceId).catch(console.error);
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", () => {
    if (session.agentWs) session.agentWs.close();
    if (session.voiceId) deleteTemporaryVoice(session.voiceId).catch(console.error);
  });

  ws.on("error", (err) => console.error("twilio ws error:", err));
});

function connectToAgent(session, twilioWs) {
  const agentWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
    { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
  );

  session.agentWs = agentWs;

  agentWs.on("open", () => {
    console.log(`[${session.callSid}] agent connected — injecting cloned voice...`);

    // Override agent voice with the caller's clone
    agentWs.send(JSON.stringify({
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        tts: { voice_id: session.voiceId },
        agent: { first_message: "" },
      },
    }));
  });

  agentWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "audio") {
        const audioBuffer = Buffer.from(data.audio_event.audio_base_64, "base64");
        const mulawBuffer = pcm16000ToMulaw(audioBuffer);

        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: mulawBuffer.toString("base64") },
          }));
        }
      }

      if (data.type === "conversation_initiation_metadata") {
        console.log(`[${session.callSid}] agent live — caller will now hear their own voice`);
      }

      if (data.type === "transcript") {
        const speaker = data.transcript_event?.speaker;
        const text = data.transcript_event?.text;
        if (text) console.log(`[${session.callSid}] ${speaker}: "${text}"`);
      }

      if (data.type === "interruption") {
        console.log(`[${session.callSid}] interrupted`);
      }

    } catch (err) {
      console.error("agent message error:", err);
    }
  });

  agentWs.on("error", (err) => console.error(`[${session.callSid}] agent error:`, err));
  agentWs.on("close", () => console.log(`[${session.callSid}] agent disconnected`));
}

async function createInstantVoiceClone(wavBuffer, callSid) {
  const form = new FormData();
  form.append("name", `double-${callSid.slice(-8)}`);
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
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  console.log(`deleted voice ${voiceId}`);
}

// mulaw/8000 → PCM/16000 for ElevenLabs input
function mulawToPcm16000(mulawBuffer) {
  const pcm8000 = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8000[i] = muLawDecode(mulawBuffer[i]);
  }

  // Upsample 8000 → 16000 via linear interpolation
  const pcm16000 = new Int16Array(pcm8000.length * 2);
  for (let i = 0; i < pcm8000.length; i++) {
    pcm16000[i * 2] = pcm8000[i];
    pcm16000[i * 2 + 1] = i < pcm8000.length - 1
      ? Math.round((pcm8000[i] + pcm8000[i + 1]) / 2)
      : pcm8000[i];
  }

  const buffer = Buffer.alloc(pcm16000.length * 2);
  for (let i = 0; i < pcm16000.length; i++) {
    buffer.writeInt16LE(pcm16000[i], i * 2);
  }
  return buffer;
}

// PCM/16000 from ElevenLabs → mulaw/8000 for Twilio
function pcm16000ToMulaw(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 4);
  const mulawBuffer = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 4);
    mulawBuffer[i] = muLawEncode(sample);
  }
  return mulawBuffer;
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

function muLawEncode(sample) {
  const MU = 255;
  const MAX = 32767;
  sample = Math.max(-MAX, Math.min(MAX, sample));
  const sign = sample < 0 ? 0x80 : 0;
  if (sign) sample = -sample;
  sample = Math.round(Math.log(1 + (MU * sample) / MAX) / Math.log(1 + MU) * MAX);
  const exponent = Math.floor(Math.log2(sample + 1)) - 3;
  const exp = Math.max(0, Math.min(7, exponent));
  const mantissa = (sample >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mantissa) & 0xff;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
});
