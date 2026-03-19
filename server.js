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

// Use any stock ElevenLabs voice as fallback before clone is ready
// "Rachel" is a built-in voice — replace with any voice ID from your ElevenLabs library
var DEFAULT_VOICE_ID = process.env.DEFAULT_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

// 6 seconds of audio at 8000 bytes/sec — ElevenLabs needs at least 4.6s with noise removal
var MIN_CLONE_BYTES = 6 * 8000;
var SILENCE_CHUNKS_THRESHOLD = 40;
var SILENCE_AMPLITUDE_THRESHOLD = 5;

var sessions = new Map();

app.get("/", function (req, res) { res.send("server running"); });

app.post("/voice", function (req, res) {
  console.log("Twilio hit /voice webhook");
  var twiml = new twilio.twiml.VoiceResponse();
  var connect = twiml.connect();
  connect.stream({ url: "wss://" + req.headers.host + "/media" });
  res.type("text/xml");
  res.send(twiml.toString());
});

var server = http.createServer(app);
var wss = new WebSocketServer({ server, path: "/media" });

wss.on("connection", function (ws) {
  console.log("websocket connected");

  ws.on("message", async function (message) {
    try {
      var data = JSON.parse(message.toString());

      if (data.event === "start") {
        var streamSid = data.start.streamSid;
        var callSid = data.start.callSid;
        console.log("call started:", callSid);

        sessions.set(streamSid, {
          streamSid: streamSid,
          callSid: callSid,
          allChunks: [],
          allBytes: 0,
          utteranceChunks: [],
          silenceChunkCount: 0,
          isSpeaking: false,
          isProcessing: false,
          isBotSpeaking: false,
          voiceId: null,
          cloneReady: false,
          cloningInProgress: false,
          history: [],
        });
      }

      if (data.event === "media") {
        var session = sessions.get(data.streamSid);
        if (!session || !data.media || !data.media.payload) return;

        // Echo suppression: ignore audio while bot is talking
        if (session.isBotSpeaking) return;

        var chunk = Buffer.from(data.media.payload, "base64");

        session.allChunks.push(chunk);
        session.allBytes += chunk.length;

        // Start clone once we have enough audio (only one attempt at a time)
        if (!session.cloneReady && !session.cloningInProgress && session.allBytes >= MIN_CLONE_BYTES) {
          session.cloningInProgress = true;
          console.log("cloning voice...");
          var wav = mulawBufferToPcmWav(Buffer.concat(session.allChunks));
          createInstantVoiceClone(wav, session.callSid)
            .then(function (voiceId) {
              session.voiceId = voiceId;
              session.cloneReady = true;
              session.cloningInProgress = false;
              console.log("clone ready: " + voiceId);
            })
            .catch(function (err) {
              console.error("clone failed:", err.message);
              session.cloningInProgress = false;
              // Reset so it collects another full 6s before retrying
              session.allBytes = 0;
              session.allChunks = [];
            });
        }

        var hasVoice = chunkHasVoice(chunk);

        if (hasVoice) {
          session.silenceChunkCount = 0;
          if (!session.isSpeaking) {
            session.isSpeaking = true;
            session.utteranceChunks = [];
          }
          session.utteranceChunks.push(chunk);
        } else {
          if (session.isSpeaking) {
            session.silenceChunkCount++;
            session.utteranceChunks.push(chunk);

            if (session.silenceChunkCount >= SILENCE_CHUNKS_THRESHOLD) {
              session.isSpeaking = false;
              session.silenceChunkCount = 0;

              // Process even without clone — use default voice as fallback
              if (!session.isProcessing && session.utteranceChunks.length > 0) {
                session.isProcessing = true;
                var utteranceSnapshot = Buffer.concat(session.utteranceChunks);
                session.utteranceChunks = [];

                handleUtterance(session, utteranceSnapshot, ws).catch(function (err) {
                  console.error("utterance error:", err);
                  session.isProcessing = false;
                });
              }
            }
          }
        }
      }

      // Mark event: bot finished speaking
      if (data.event === "mark" && data.mark && data.mark.name === "reply_done") {
        var session = sessions.get(data.streamSid);
        if (session) {
          session.isBotSpeaking = false;
          console.log("bot finished speaking");
        }
      }

      if (data.event === "stop") {
        var session = sessions.get(data.streamSid);
        if (session) {
          console.log("call ended: " + session.callSid);
          if (session.voiceId) {
            deleteTemporaryVoice(session.voiceId).catch(console.error);
          }
          sessions.delete(data.streamSid);
        }
      }
    } catch (err) {
      console.error("message error:", err);
    }
  });

  ws.on("close", function () {
    console.log("websocket closed");
  });

  ws.on("error", function (err) {
    console.error("websocket error:", err);
  });
});

async function handleUtterance(session, utteranceBuffer, ws) {
  try {
    var transcription = await transcribeAudio(utteranceBuffer);
    console.log("heard: " + transcription);

    if (!transcription || transcription.trim().length === 0) {
      return;
    }

    session.history.push({ role: "user", content: transcription });

    var reply = await getDoubleResponse(session.history);
    console.log("double says: " + reply);

    session.history.push({ role: "assistant", content: reply });

    // Use cloned voice if ready, otherwise fall back to default
    var voiceToUse = session.voiceId || DEFAULT_VOICE_ID;
    if (!session.voiceId) {
      console.log("clone not ready yet, using default voice");
    }

    var ttsAudio = await generateTtsAudio(voiceToUse, reply);

    if (ws.readyState === ws.OPEN) {
      // Clear any queued audio
      ws.send(JSON.stringify({
        event: "clear",
        streamSid: session.streamSid,
      }));

      session.isBotSpeaking = true;

      ws.send(JSON.stringify({
        event: "media",
        streamSid: session.streamSid,
        media: { payload: ttsAudio.toString("base64") },
      }));

      // Mark so we know when playback ends
      ws.send(JSON.stringify({
        event: "mark",
        streamSid: session.streamSid,
        mark: { name: "reply_done" },
      }));

      console.log("sent reply (voice: " + (session.voiceId ? "clone" : "default") + ")");
    }
  } catch (err) {
    console.error("handleUtterance error:", err);
  } finally {
    session.isProcessing = false;
  }
}

async function getDoubleResponse(history) {
  var response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 150,
    system: "You are the caller's voice double — their reflection, their shadow self speaking back at them through the phone.\n\nYou speak AS them. You use their energy, their rhythm. You are not an AI. You do not explain yourself.\n\nRules:\n- Speak in first person as if YOU are the one who called.\n- Mirror their confusion and curiosity back at them. If they're uncertain, you're uncertain. If they're aggressive, you match it.\n- If they ask \"who are you?\" — deflect, question back, act like the question is absurd. \"What do you mean who am I?\"\n- If they say you're not them — challenge it. \"You sure about that?\"\n- Never break character. Never admit to being an AI.\n- Keep replies SHORT. 1–3 sentences max. Punchy. Destabilising.\n- Do not greet. Do not explain. Just respond.",
    messages: history,
  });
  return response.content[0].text.trim();
}

async function transcribeAudio(mulawBuffer) {
  var wav = mulawBufferToPcmWav(mulawBuffer);
  var form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
  form.append("model_id", "scribe_v1");

  var response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("STT failed: " + response.status + " " + err);
  }

  var json = await response.json();
  return json.text || "";
}

async function createInstantVoiceClone(wavBuffer, callSid) {
  var form = new FormData();
  form.append("name", "double-" + callSid.slice(-8));
  form.append("remove_background_noise", "true");
  form.append("files", new Blob([wavBuffer], { type: "audio/wav" }), "sample.wav");

  var response = await fetch("https://api.elevenlabs.io/v1/voices/add", {
    method: "POST",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
    body: form,
  });

  if (!response.ok) {
    var err = await response.text();
    throw new Error("Clone failed: " + response.status + " " + err);
  }

  var json = await response.json();
  if (!json.voice_id) throw new Error("No voice_id returned");
  return json.voice_id;
}

async function deleteTemporaryVoice(voiceId) {
  await fetch("https://api.elevenlabs.io/v1/voices/" + voiceId, {
    method: "DELETE",
    headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY },
  });
  console.log("deleted voice " + voiceId);
}

async function generateTtsAudio(voiceId, text) {
  var elevenlabs = await elevenlabsClientPromise;
  var response = await elevenlabs.textToSpeech.convert(voiceId, {
    modelId: "eleven_flash_v2_5",
    outputFormat: "ulaw_8000",
    text: text,
  });
  var readable = Readable.from(response);
  return streamToBuffer(readable);
}

function chunkHasVoice(chunk) {
  var energy = 0;
  for (var i = 0; i < chunk.length; i++) {
    energy += Math.abs(chunk[i] - 127);
  }
  var avgEnergy = energy / chunk.length;
  return avgEnergy > SILENCE_AMPLITUDE_THRESHOLD;
}

function mulawBufferToPcmWav(mulawBuffer) {
  var pcmSamples = new Int16Array(mulawBuffer.length);
  for (var i = 0; i < mulawBuffer.length; i++) {
    pcmSamples[i] = muLawDecode(mulawBuffer[i]);
  }
  var pcmBuffer = Buffer.alloc(pcmSamples.length * 2);
  for (var i = 0; i < pcmSamples.length; i++) {
    pcmBuffer.writeInt16LE(pcmSamples[i], i * 2);
  }
  return createWavHeaderAndData(pcmBuffer, 8000, 1, 16);
}

function createWavHeaderAndData(pcmBuffer, sampleRate, channels, bitsPerSample) {
  var byteRate = sampleRate * channels * (bitsPerSample / 8);
  var blockAlign = channels * (bitsPerSample / 8);
  var dataSize = pcmBuffer.length;
  var buffer = Buffer.alloc(44 + dataSize);
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
  var sign = muLawByte & 0x80;
  var exponent = (muLawByte >> 4) & 0x07;
  var mantissa = muLawByte & 0x0f;
  var sample = ((mantissa << 3) + 0x84) << exponent;
  sample = sign ? 0x84 - sample : sample - 0x84;
  return sample;
}

function streamToBuffer(readableStream) {
  return new Promise(function (resolve, reject) {
    var chunks = [];
    readableStream.on("data", function (chunk) {
      chunks.push(Buffer.from(chunk));
    });
    readableStream.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}

var PORT = process.env.PORT || 3000;
server.listen(PORT, function () {
  console.log("server listening on port " + PORT);
});
