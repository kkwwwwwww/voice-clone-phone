require("dotenv").config();

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const twilio = require("twilio");

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (req, res) => {
  res.send("server running");
});

app.post("/voice", (req, res) => {
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

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.event === "connected") {
        console.log("twilio stream connected");
      }

      if (data.event === "start") {
        console.log("call started:", data.start.callSid);
      }

      if (data.event === "media") {
        console.log("media packet received");
      }

      if (data.event === "stop") {
        console.log("call stopped");
      }
    } catch (error) {
      console.error("could not parse message");
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`server listening on port ${PORT}`);
});

