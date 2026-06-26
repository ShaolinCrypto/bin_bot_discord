import express from "express";
import nacl from "tweetnacl";

const app = express();

app.use(express.raw({ type: "*/*" }));

app.use((req, res, next) => {
  console.log("REQUEST:", req.method, req.originalUrl);
  next();
});

const PORT = process.env.PORT || 8080;

const DISCORD_PING = 1;
const APPLICATION_COMMAND = 2;
const CHANNEL_MESSAGE_WITH_SOURCE = 4;

app.post("/test", (req, res) => {
  console.log("POST /test received");
  res.send("POST test OK");
});

app.post("/interactions", async (req, res) => {
  console.log("POST /interactions received");

  const signature = req.header("x-signature-ed25519");
  const timestamp = req.header("x-signature-timestamp");

  if (!signature || !timestamp) {
    console.log("Missing Discord signature headers");
    return res.status(401).send("Missing signature headers");
  }

  const isVerified = nacl.sign.detached.verify(
    Buffer.from(timestamp + req.body.toString("utf8")),
    Buffer.from(signature, "hex"),
    Buffer.from(process.env.DISCORD_PUBLIC_KEY, "hex")
  );

  if (!isVerified) {
    console.log("Signature verification failed");
    return res.status(401).send("Invalid request signature");
  }

  console.log("Signature verified");

  const interaction = JSON.parse(req.body.toString("utf8"));

  if (interaction.type === DISCORD_PING) {
    return res.json({ type: 1 });
  }

  if (
    interaction.type === APPLICATION_COMMAND &&
    interaction.data?.name === "binping"
  ) {
    console.log("binping command received");

    return res.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "✅ Discord interaction received!"
      }
    });
  }

  if (
    interaction.type === APPLICATION_COMMAND &&
    interaction.data?.name === "bins"
  ) {
    console.log("Bins command received");
    const payload = await getBinsEmbed();
    console.log("Bins payload ready");
    return res.json(payload);
  }

  return res.json({
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      content: "Unknown command.",
      flags: 64
    }
  });
});

app.get("/", (_, res) => {
  res.send("Leeds bins Discord bot is running.");
});

async function registerCommands() {
  const appId = process.env.DISCORD_APPLICATION_ID;
  const botToken = process.env.DISCORD_BOT_TOKEN;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!appId || !botToken) {
    console.log("Skipping command registration: missing app ID or bot token.");
    return;
  }

  console.log("Registering", guildId ? "guild" : "global", "commands");

  const commands = [
    {
      name: "bins",
      description: "Show upcoming Leeds bin collection dates"
    },
    {
      name: "binping",
      description: "Test the Discord interaction endpoint"
    }
  ];

  const url = guildId
    ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
    : `https://discord.com/api/v10/applications/${appId}/commands`;

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  const text = await response.text();

  if (!response.ok) {
    console.error("Command registration failed:", response.status, text);
    return;
  }

  console.log("Command registration complete:", response.status, text);
}

registerCommands()
  .catch(err => console.error("Command registration crashed:", err))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Listening on port ${PORT}`);
    });
  });

async function getBinsEmbed() {
  const startDate = new Date().toISOString().slice(0, 10);
  const endDate = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);

  const url =
    "https://api.leeds.gov.uk/public/waste/v1/BinsDays" +
    `?uprn=${encodeURIComponent(process.env.UPRN)}` +
    `&startDate=${startDate}` +
    `&endDate=${endDate}`;

  console.log("Fetching Leeds bins API");

  const response = await fetch(url);

  console.log("Leeds API status:", response.status);

  if (!response.ok) {
    return {
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `Leeds bins API returned ${response.status}.`,
        flags: 64
      }
    };
  }

  const raw = await response.json();
  const collections = normaliseBinsResponse(raw);

  if (!collections.length) {
    return {
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        embeds: [
          {
            title: "🗑️ Bin collections",
            description: "No upcoming collections found.",
            color: 0xffcc00
          }
        ]
      }
    };
  }

  const next = collections[0];
  const upcoming = collections.slice(0, 8);

  return {
    type: CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: "🗑️ Upcoming bin collections",
          description: `Next collection: **${next.type}** on **${formatDate(next.date)}**`,
          color: colourForBin(next.type),
          fields: upcoming.map(item => ({
            name: item.type,
            value: formatDate(item.date),
            inline: true
          })),
          footer: {
            text: "Leeds City Council"
          },
          timestamp: new Date().toISOString()
        }
      ]
    }
  };
}

function normaliseBinsResponse(raw) {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.data)
      ? raw.data
      : Array.isArray(raw?.bins)
        ? raw.bins
        : Array.isArray(raw?.binDays)
          ? raw.binDays
          : [];

  return rows
    .map(row => ({
      date:
        row.date ||
        row.collectionDate ||
        row.CollectionDate ||
        row.binDay ||
        row.BinDay,
      type:
        row.type ||
        row.binType ||
        row.BinType ||
        row.name ||
        row.binName ||
        row.BinName ||
        "Collection"
    }))
    .filter(item => item.date)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London"
  }).format(new Date(value));
}

function colourForBin(type) {
  const t = String(type).toLowerCase();

  if (t.includes("black") || t.includes("general")) return 0x2f3136;
  if (t.includes("green") || t.includes("garden")) return 0x2ecc71;
  if (t.includes("brown")) return 0x8b4513;
  if (t.includes("recycl")) return 0x3498db;

  return 0x5865f2;
}
