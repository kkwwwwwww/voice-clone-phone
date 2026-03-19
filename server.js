require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

const CLONE_THRESHOLD_BYTES = 5 * 8000;

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
    cloneDone: false,
    voiceId: null,
    agentWs: null,
  };

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "start") {
        session.streamSid = data.start.streamSid;
        session.callSid = data.start.callSid;
        console.log("call started:", session.callSid);
        connectAgent(session, ws, null);
      }

      if (data.event === "media") {
        if (!data.media?.payload) return;

        const chunk = Buffer.from(data.media.payload, "base64");
        session.allChunks.push(chunk);
        session.allBytes += chunk.length;

        if (session.agentWs && session.agentWs.readyState === WebSocket.OPEN) {
          const pcm = mulawToPcm16000(chunk);
          session.agentWs.send(JSON.stringify({
            user_audio_chunk: pcm.toString("base64"),
          }));
        }

        if (!session.cloneDone && session.allBytes >= CLONE_THRESHOLD_BYTES) {
          session.cloneDone = true;
          console.log(`[${session.callSid}] cloning voice...`);
          try {
            const wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
            const voiceId = await createClone(wav, session.callSid);
            session.voiceId = voiceId;
            console.log(`[${session.callSid}] clone ready — reconnecting with caller's voice`);
            if (session.agentWs) session.agentWs.close();
            connectAgent(session, ws, voiceId);
          } catch (err) {
            console.error(`[${session.callSid}] clone error:`, err);
          }
        }
      }

      if (data.event === "stop") {
        console.log(`call ended: ${session.callSid}`);
        if (session.agentWs) session.agentWs.close();
        if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", () => {
    if (session.agentWs) session.agentWs.close();
    if (session.voiceId) deleteVoice(session.voiceId).catch(console.error);
  });

  ws.on("error", (err) => console.error("ws error:", err));
});

function connectAgent(session, twilioWs, voiceId) {
  const agentWs = new WebSocket(
    `wss://api.elevenlabs.io/v1/convai/conversation?agent_id=${process.env.ELEVENLABS_AGENT_ID}`,
    { headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY } }
  );

  session.agentWs = agentWs;

  agentWs.on("open", () => {
    console.log(`[${session.callSid}] agent connected — ${voiceId ? "CLONE VOICE" : "default voice"}`);

    const init = {
      type: "conversation_initiation_client_data",
      conversation_config_override: {
        agent: { first_message: "" },
      },
    };

    if (voiceId) {
      init.conversation_config_override.tts = { voice_id: voiceId };
    }

    agentWs.send(JSON.stringify(init));
  });

  agentWs.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "audio") {
        const pcmBuffer = Buffer.from(data.audio_event.audio_base_64, "base64");
        const mulaw = pcm16000ToMulaw8000(pcmBuffer);
        if (twilioWs.readyState === twilioWs.OPEN) {
          twilioWs.send(JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: mulaw.toString("base64") },
          }));
        }
      }

      if (data.type === "conversation_initiation_metadata") {
        console.log(`[${session.callSid}] agent live`);
      }

      if (data.type === "transcript") {
        const speaker = data.transcript_event?.speaker;
        const text = data.transcript_event?.text;
        if (text) console.log(`[${session.callSid}] ${speaker}: "${text}"`);
      }

    } catch (err) {
      console.error("agent message error:", err);
    }
  });

  agentWs.on("error", (err) => console.error("agent error:", err));
  agentWs.on("close", () => console.log(`[${session.callSid}] agent closed`));
}

async function createClone(wavBuffer, callSid) {
  const form = new FormData();
  form.append("name", `double-${callSid.slice(-8)}`);
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([wavBuffer], { type: "audio/wav" }), "sample.wav");

  const response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) throw new Error(`Clone failed: ${await response.text()}`);
  const json = await response.json();
  if (!json.voice_id) throw new Error("No voice_id");
  return json.voice_id;
}

async function deleteVoice(voiceId) {
  await fetch(`https://api.elevenlabs.io/v1/voices/${voiceId}`, {
    method: "DELETE",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  console.log(`deleted ${voiceId}`);
}

function mulawToPcm16000(mulawBuffer) {
  const pcm8k = new Int16Array(mulawBuffer.length);
  for (let i = 0; i < mulawBuffer.length; i++) {
    pcm8k[i] = muLawDecode(mulawBuffer[i]);
  }
  const pcm16k = new Int16Array(pcm8k.length * 2);
  for (let i = 0; i < pcm8k.length; i++) {
    pcm16k[i * 2] = pcm8k[i];
    pcm16k[i * 2 + 1] = i < pcm8k.length - 1
      ? Math.round((pcm8k[i] + pcm8k[i + 1]) / 2)
      : pcm8k[i];
  }
  const buf = Buffer.alloc(pcm16k.length * 2);
  for (let i = 0; i < pcm16k.length; i++) buf.writeInt16LE(pcm16k[i], i * 2);
  return buf;
}

function pcm16000ToMulaw8000(pcmBuffer) {
  const sampleCount = Math.floor(pcmBuffer.length / 4);
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcmBuffer.readInt16LE(i * 4);
    out[i] = muLawEncode(sample);
  }
  return out;
}

function muLawEncode(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
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
server.listen(PORT, () => console.log(`server listening on port ${PORT}`));
