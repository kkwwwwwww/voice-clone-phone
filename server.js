
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Readable } = require("stream");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");

const elevenlabsClientPromise = import("@elevenlabs/elevenlabs-js").then(
  ({ ElevenLabsClient }) =>
    new ElevenLabsClient({
      apiKey: process.env.ELEVENLABS_API_KEY,
    })
);

const app = express();
app.use(express.urlencoded({ extended: false }));

const TEST_VOICE_ID = "aMSt68OGf4xUZAnLpTU8";
const INTRO_TEXT = "you called, so start speaking. i am listening.";

// Twilio inbound phone audio is mulaw/8000, so 1 byte ~= 1 sample.
// 30 seconds at 8000 samples/sec = about 240000 bytes.
const CLONE_TARGET_SECONDS = 30;
const CLONE_TARGET_BYTES = CLONE_TARGET_SECONDS * 8000;

let cachedIntroAudio = null;
const sessions = new Map();

app.get("/", (req, res) => {
  res.send("server running");
});

app.post("/voice", (req, res) => {
  console.log("Twilio hit /voice webhook");

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();

  connect.stream({
    url: `wss://${req.headers.host}/media`,
  });

  res.type("text/xml");
  res.send(twiml.toString());
});

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: "/media",
});

wss.on("connection", (ws) => {
  console.log("websocket connected");

  ws.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "connected") {
        console.log("twilio stream connected");
      }

      if (data.event === "start") {
        const streamSid = data.start.streamSid;
        const callSid = data.start.callSid;

        console.log("call started:", callSid);

        sessions.set(streamSid, {
          streamSid,
          callSid,
          rawChunks: [],
          rawBytes: 0,
          sampleReady: false,
          voiceId: null,
          cloneStatus: "waiting",
        });

        const audioBuffer = await getCachedIntroAudio();

        ws.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: audioBuffer.toString("base64"),
            },
          })
        );

        console.log("sent cached spoken reply into call");
      }

      if (data.event === "media") {
        const streamSid = data.streamSid;
        const session = sessions.get(streamSid);

        if (!session || !data.media || !data.media.payload) {
          return;
        }

        const rawChunk = Buffer.from(data.media.payload, "base64");
        session.rawChunks.push(rawChunk);
        session.rawBytes += rawChunk.length;

        const capturedSeconds = (session.rawBytes / 8000).toFixed(1);

        if (
          !session.sampleReady &&
          session.rawBytes >= CLONE_TARGET_BYTES
        ) {
          session.sampleReady = true;
          console.log(
            `clone sample ready for ${session.callSid} (${capturedSeconds}s captured)`
          );
        }

        // optional lighter log, comment out if too noisy
        // console.log(`capturing ${session.callSid}: ${capturedSeconds}s`);
      }

      if (data.event === "stop") {
        const streamSid = data.streamSid;
        const session = sessions.get(streamSid);

        if (session) {
          const capturedSeconds = (session.rawBytes / 8000).toFixed(1);
          console.log(
            `call stopped: ${session.callSid}, captured ${capturedSeconds}s`
          );
          sessions.delete(streamSid);
        } else {
          console.log("call stopped");
        }
      }
    } catch (error) {
      console.error("message handling error:", error);
    }
  });

  ws.on("error", (err) => {
    console.error("websocket error:", err);
  });
});

async function getCachedIntroAudio() {
  if (cachedIntroAudio) {
    return cachedIntroAudio;
  }

  const elevenlabs = await elevenlabsClientPromise;

  const response = await elevenlabs.textToSpeech.convert(TEST_VOICE_ID, {
    modelId: "eleven_flash_v2_5",
    outputFormat: "ulaw_8000",
    text: INTRO_TEXT,
  });

  const readableStream = Readable.from(response);
  cachedIntroAudio = await streamToBuffer(readableStream);

  console.log("cached intro audio ready");

  return cachedIntroAudio;
}

function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    readableStream.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk));
    });

    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    readableStream.on("error", reject);
  });
}

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  console.log(`server listening on port ${PORT}`);

  try {
    await getCachedIntroAudio();
  } catch (error) {
    console.error("failed to pre-cache intro audio:", error);
  }
});
