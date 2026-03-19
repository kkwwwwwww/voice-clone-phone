require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");
const Anthropic = require("@anthropic-ai/sdk");

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(express.urlencoded({ extended: false }));

const DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

const elevenlabsClientPromise = import("@elevenlabs/elevenlabs-js").then(
  ({ ElevenLabsClient }) =>
    new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
);

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

wss.on("connection", (ws) => {
  console.log("[twilio] WebSocket connected");

  const session = {
    streamSid: null,
    callSid: null,
    voiceId: DEFAULT_VOICE_ID,
    isProcessing: false,
    deepgramWs: null,
    pendingTranscript: "",
    history: [],
    ttsQueue: [],
    ttsPlaying: false,
  };

  // ─── Deepgram live STT ────────────────────────────────────────
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

        if (msg.type === "UtteranceEnd") {
          console.log("[deepgram] UtteranceEnd detected");
          if (session.pendingTranscript.trim() && !session.isProcessing) {
            processUtterance(session.pendingTranscript.trim());
            session.pendingTranscript = "";
          }
          return;
        }

        if (msg.channel && msg.channel.alternatives && msg.channel.alternatives[0]) {
          const transcript = msg.channel.alternatives[0].transcript;
          if (!transcript) return;

          if (msg.is_final) {
            session.pendingTranscript += " " + transcript;
            console.log("[deepgram] Final: " + transcript);
          }
        }
      } catch (e) {}
    });

    session.deepgramWs.on("error", (err) => {
      console.error("[deepgram] Error:", err.message);
    });

    session.deepgramWs.on("close", () => {
      console.log("[deepgram] Closed");
    });
  }

  startDeepgram();

  // ─── Process utterance ────────────────────────────────────────
  async function processUtterance(text) {
    if (!text || session.isProcessing) return;
    session.isProcessing = true;
    console.log("[process] Caller said: " + text);

    try {
      session.history.push({ role: "user", content: text });

      const stream = anthropic.messages.stream({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
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
      let firstChunkTime = null;
      const startTime = Date.now();

      // Collect the FULL response, then send to TTS as one piece
      // This avoids sentence-splitting bugs and overlapping audio
      stream.on("text", (text) => {
        if (!firstChunkTime) {
          firstChunkTime = Date.now();
          console.log("[claude] First token: " + (firstChunkTime - startTime) + "ms");
        }
        fullResponse += text;
      });

      await stream.finalMessage();

      console.log("[claude] Full response: " + fullResponse);

      if (fullResponse.trim()) {
        session.history.push({ role: "assistant", content: fullResponse });
        // Send entire response as one TTS request — clean audio, no overlap
        queueTTS(fullResponse.trim());
      }

      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }
    } catch (err) {
      console.error("[process] Error:", err.message);
    } finally {
      session.isProcessing = false;
    }
  }

  // ─── TTS queue — one at a time, no overlap ────────────────────
  function queueTTS(text) {
    session.ttsQueue.push(text);
    if (!session.ttsPlaying) {
      playNextTTS();
    }
  }

  async function playNextTTS() {
    if (session.ttsQueue.length === 0) {
      session.ttsPlaying = false;
      return;
    }

    session.ttsPlaying = true;
    const text = session.ttsQueue.shift();

    try {
      const elevenlabs = await elevenlabsClientPromise;
      const startTime = Date.now();

      const audioStream = await elevenlabs.textToSpeech.convert(
        session.voiceId,
        {
          text: text,
          model_id: "eleven_turbo_v2",
          output_format: "ulaw_8000",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }
      );

      console.log("[tts] Playing: " + text.substring(0, 50) + "...");
      let firstChunk = true;

      for await (const chunk of audioStream) {
        if (firstChunk) {
          console.log("[tts] First audio chunk: " + (Date.now() - startTime) + "ms");
          firstChunk = false;
        }

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

      console.log("[tts] Done playing");
    } catch (err) {
      console.error("[tts] Error:", err.message);
    }

    // Play next in queue
    playNextTTS();
  }

  // ─── Twilio WebSocket messages ────────────────────────────────
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
          if (
            session.deepgramWs &&
            session.deepgramWs.readyState === WebSocket.OPEN
          ) {
            session.deepgramWs.send(audio);
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
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server listening on port " + PORT);
});
