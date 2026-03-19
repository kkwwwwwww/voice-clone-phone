require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

// ─── Clients ────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Lazy-load ElevenLabs (ESM module)
const elevenlabsClientPromise = import("@elevenlabs/elevenlabs-js").then(
  ({ ElevenLabsClient }) =>
    new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
);

const app = express();
app.use(express.urlencoded({ extended: false }));

// ─── Config ─────────────────────────────────────────────────────────
const SILENCE_THRESHOLD_MS = 800;    // Process after 800ms of silence (was 5000ms!)
const ENERGY_FLOOR = 30;             // Mulaw energy level below which = silence
const CLONE_AUDIO_NEEDED = 6 * 8000; // 6 seconds of audio before attempting clone
const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; // Rachel - fallback voice

// ─── Express routes ─────────────────────────────────────────────────
app.get("/", (req, res) => res.send("server running"));

app.post("/voice", (req, res) => {
  console.log("[twilio] /voice webhook hit");
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({ url: "wss://" + req.headers.host + "/media" });
  res.type("text/xml");
  res.send(twiml.toString());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

// ─── WebSocket handler (one per call) ───────────────────────────────
wss.on("connection", (ws) => {
  console.log("[twilio] WebSocket connected");

  const session = {
    streamSid: null,
    callSid: null,

    // Audio capture for voice cloning (background)
    cloneChunks: [],
    cloneBytes: 0,
    voiceId: DEFAULT_VOICE_ID,
    cloneInProgress: false,
    cloneDone: false,

    // Current utterance being captured
    utteranceChunks: [],
    silenceTimer: null,
    isSpeaking: false,
    isProcessing: false,

    // Deepgram live STT websocket
    deepgramWs: null,
    pendingTranscript: "",

    // Conversation history for Claude
    history: [],

    // Track if we're currently playing audio (for barge-in)
    isPlaying: false,
  };

  // ─── Start Deepgram live STT ────────────────────────────────────
  function startDeepgram() {
    const dgUrl =
      "wss://api.deepgram.com/v1/listen?" +
      "encoding=mulaw&sample_rate=8000&channels=1" +
      "&punctuate=true&interim_results=true&endpointing=500" +
      "&vad_events=true&utterance_end_ms=1000";

    session.deepgramWs = new WebSocket(dgUrl, {
      headers: { Authorization: "Token " + process.env.DEEPGRAM_API_KEY },
    });

    session.deepgramWs.on("open", () => {
      console.log("[deepgram] Live STT connected");
    });

    session.deepgramWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Deepgram's UtteranceEnd event = caller stopped talking
        if (msg.type === "UtteranceEnd") {
          console.log("[deepgram] UtteranceEnd detected");
          if (session.pendingTranscript.trim() && !session.isProcessing) {
            processUtterance(session.pendingTranscript.trim());
            session.pendingTranscript = "";
          }
          return;
        }

        // Transcript results
        if (msg.channel && msg.channel.alternatives && msg.channel.alternatives[0]) {
          const transcript = msg.channel.alternatives[0].transcript;
          if (!transcript) return;

          if (msg.is_final) {
            session.pendingTranscript += " " + transcript;
            console.log("[deepgram] Final: " + transcript);
          }
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    session.deepgramWs.on("error", (err) => {
      console.error("[deepgram] Error:", err.message);
    });

    session.deepgramWs.on("close", () => {
      console.log("[deepgram] Closed");
    });
  }

  startDeepgram();

  // ─── Process an utterance (the fast path) ─────────────────────────
  async function processUtterance(text) {
    if (!text || session.isProcessing) return;
    session.isProcessing = true;
    console.log("[process] Caller said: " + text);

    try {
      // Add to conversation history
      session.history.push({ role: "user", content: text });

      // ── Step 1: Stream Claude's response ──
      // We collect text sentence-by-sentence and pipe each to TTS immediately
      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300, // Keep responses SHORT for phone calls
        system:
          "You are a human named Sam on a phone call. " +
          "Speak naturally and conversationally — short sentences, " +
          "casual language, like a real person on the phone. " +
          "Use filler words occasionally (um, well, yeah). " +
          "Keep responses to 1-3 sentences max. " +
          "Never say you're an AI.",
        messages: session.history,
      });

      let fullResponse = "";
      let sentenceBuffer = "";

      // Track if this is the first chunk (for latency logging)
      let firstChunkTime = null;
      const startTime = Date.now();

      stream.on("text", (text) => {
        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          console.log("[claude] First token: " + (firstChunkTime - startTime) + "ms");
        }

        fullResponse += text;
        sentenceBuffer += text;

        // Check for sentence boundaries
        const sentenceEnd = sentenceBuffer.match(/[.!?]\s|[.!?]$/);
        if (sentenceEnd) {
          const sentence = sentenceBuffer.trim();
          sentenceBuffer = "";

          if (sentence) {
            // Fire off TTS for this sentence immediately — don't wait
            streamTTSToTwilio(sentence);
          }
        }
      });

      // Wait for Claude to finish
      await stream.finalMessage();

      // Flush any remaining text
      if (sentenceBuffer.trim()) {
        streamTTSToTwilio(sentenceBuffer.trim());
      }

      // Save to history
      session.history.push({ role: "assistant", content: fullResponse });
      console.log("[claude] Full response: " + fullResponse);

      // Keep history manageable (last 10 turns)
      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }
    } catch (err) {
      console.error("[process] Error:", err.message);
    } finally {
      session.isProcessing = false;
    }
  }

  // ─── Stream TTS audio directly to Twilio ──────────────────────────
  async function streamTTSToTwilio(text) {
    try {
      const elevenlabs = await elevenlabsClientPromise;
      const startTime = Date.now();

      // Use streaming TTS — audio starts arriving in ~300ms
      const audioStream = await elevenlabs.textToSpeech.convert(
        session.voiceId,
        {
          text: text,
          model_id: "eleven_turbo_v2", // Fastest model (~300ms latency)
          output_format: "ulaw_8000",  // Native Twilio format — no conversion needed
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }
      );

      console.log("[tts] Streaming audio for: " + text.substring(0, 40) + "...");
      let firstChunk = true;

      // audioStream is an async iterable of audio chunks
      for await (const chunk of audioStream) {
        if (firstChunk) {
          console.log("[tts] First audio chunk: " + (Date.now() - startTime) + "ms");
          firstChunk = false;
        }

        // Send audio chunk directly to Twilio as base64 mulaw
        if (ws.readyState === WebSocket.OPEN && session.streamSid) {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid: session.streamSid,
              media: {
                payload: Buffer.from(chunk).toString("base64"),
              },
            })
          );
        }
      }
    } catch (err) {
      console.error("[tts] Error:", err.message);
    }
  }

  // ─── Background voice cloning (never blocks the response path) ────
  async function tryCloneVoice() {
    if (session.cloneInProgress || session.cloneDone) return;
    if (session.cloneBytes < CLONE_AUDIO_NEEDED) return;

    session.cloneInProgress = true;
    console.log("[clone] Starting background voice clone (" + session.cloneBytes + " bytes)");

    try {
      const elevenlabs = await elevenlabsClientPromise;

      // Combine captured audio chunks into a single buffer
      const audioBuffer = Buffer.concat(session.cloneChunks);

      // Create an instant voice clone
      const voice = await elevenlabs.voices.add({
        name: "caller-" + (session.callSid || "unknown"),
        files: [
          {
            // ElevenLabs needs a proper audio file, so wrap raw mulaw in a WAV header
            blob: createWavBlob(audioBuffer),
            name: "caller-audio.wav",
          },
        ],
      });

      session.voiceId = voice.voice_id;
      session.cloneDone = true;
      console.log("[clone] Voice cloned! ID: " + voice.voice_id);
    } catch (err) {
      console.error("[clone] Clone failed:", err.message);
      // Will retry on next audio threshold
      session.cloneInProgress = false;
    }
  }

  // ─── Handle Twilio WebSocket messages ─────────────────────────────
  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case "start":
          session.streamSid = data.start.streamSid;
          session.callSid = data.start.callSid;
          console.log("[twilio] Stream started: " + session.streamSid);
          break;

        case "media": {
          const audio = Buffer.from(data.media.payload, "base64");

          // 1. Forward audio to Deepgram for live STT
          if (
            session.deepgramWs &&
            session.deepgramWs.readyState === WebSocket.OPEN
          ) {
            session.deepgramWs.send(audio);
          }

          // 2. Capture audio for voice cloning (background)
          if (!session.cloneDone) {
            session.cloneChunks.push(audio);
            session.cloneBytes += audio.length;

            // Try to clone once we have enough audio
            if (session.cloneBytes >= CLONE_AUDIO_NEEDED && !session.cloneInProgress) {
              tryCloneVoice(); // fire and forget — runs in background
            }
          }
          break;
        }

        case "stop":
          console.log("[twilio] Stream stopped");
          cleanup();
          break;
      }
    } catch (err) {
      console.error("[ws] Error:", err.message);
    }
  });

  ws.on("close", () => {
    console.log("[twilio] WebSocket closed");
    cleanup();
  });

  function cleanup() {
    if (session.deepgramWs) {
      session.deepgramWs.close();
    }
    if (session.silenceTimer) {
      clearTimeout(session.silenceTimer);
    }
    // Optionally: delete the cloned voice to save quota
    // elevenlabsClientPromise.then(el => el.voices.delete(session.voiceId));
  }
});

// ─── Helper: wrap raw mulaw audio in a WAV header ───────────────────
function createWavBlob(mulawData) {
  const header = Buffer.alloc(44);
  const dataSize = mulawData.length;
  const fileSize = dataSize + 36;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // chunk size
  header.writeUInt16LE(7, 20);        // format = mulaw
  header.writeUInt16LE(1, 22);        // channels
  header.writeUInt32LE(8000, 24);     // sample rate
  header.writeUInt32LE(8000, 28);     // byte rate
  header.writeUInt16LE(1, 32);        // block align
  header.writeUInt16LE(8, 34);        // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return new Blob([header, mulawData], { type: "audio/wav" });
}

// ─── Start server ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
