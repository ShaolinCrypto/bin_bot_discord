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
const DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE = 5;

app.post("/test", (req, res) => {
  console.log("POST /test received");
  res.send("POST test OK");
});

async function handleInteraction(req, res) {
  console.log("Interaction POST received at", req.originalUrl);

  try {
    const signature = req.header("x-signature-ed25519");
    const timestamp = req.header("x-signature-timestamp");
    const publicKey = process.env.DISCORD_PUBLIC_KEY;

    if (!signature || !timestamp) {
      console.log("Missing Discord signature headers");
      return res.status(401).send("Missing signature headers");
    }

    if (!publicKey) {
      console.error("DISCORD_PUBLIC_KEY is not set");
      return res.status(500).send("Server misconfigured");
    }

    const isVerified = nacl.sign.detached.verify(
      Buffer.from(timestamp + req.body.toString("utf8")),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex")
    );

    if (!isVerified) {
      console.log("Signature verification failed");
      return res.status(401).send("Invalid request signature");
    }

    console.log("Signature verified");

    const interaction = JSON.parse(req.body.toString("utf8"));

    if (interaction.type === DISCORD_PING) {
      return res.json({ type: DISCORD_PING });
    }

    if (
      interaction.type === APPLICATION_COMMAND &&
      interaction.data?.name === "binping"
    ) {
      console.log("binping command received");

      return res.json({
        type: CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Discord interaction received!"
        }
      });
    }

    if (
      interaction.type === APPLICATION_COMMAND &&
      interaction.data?.name === "bins"
    ) {
      console.log("bins command received");

      res.json({ type: DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        const payload = await getBinsEmbed();
        console.log("bins payload ready");
        await sendFollowUp(interaction, payload.data);
      } catch (err) {
        console.error("bins command failed:", err);
        await sendFollowUp(interaction, {
          content: "Something went wrong fetching bin dates. Please try again.",
          flags: 64
        });
      }
      return;
    }

    return res.json({
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "Unknown command.",
        flags: 64
      }
    });
  } catch (err) {
    console.error("Interaction handler error:", err);

    if (!res.headersSent) {
      return res.status(500).send("Internal server error");
    }
  }
}

async function sendFollowUp(interaction, data) {
  const appId = process.env.DISCORD_APPLICATION_ID;

  if (!appId) {
    throw new Error("DISCORD_APPLICATION_ID is not set");
  }

  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${appId}/${interaction.token}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Discord follow-up failed: ${response.status} ${text}`);
  }
}

app.post("/", handleInteraction);
app.post("/interactions", handleInteraction);

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
  const premisesId = process.env.PREMISES_ID || process.env.UPRN;

  if (!premisesId) {
    return {
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: "PREMISES_ID (or UPRN) is not configured on the server.",
        flags: 64
      }
    };
  }

  const url = `https://bins.felixyeung.com/api/jobs?premises=${encodeURIComponent(premisesId)}`;

  console.log("Fetching Leeds bins API for premises", premisesId);

  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });

  console.log("Leeds bins API status:", response.status);

  if (!response.ok) {
    return {
      type: CHANNEL_MESSAGE_WITH_SOURCE,
      data: {
        content: `Leeds bins API returned ${response.status}. Check PREMISES_ID is valid.`,
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
            title: "Bin collections",
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
          title: "Upcoming bin collections",
          description: `Next collection: **${next.type}** on **${formatDate(next.date)}**`,
          color: colourForBin(next.type),
          fields: upcoming.map(item => ({
            name: item.type,
            value: formatDate(item.date),
            inline: true
          })),
          footer: {
            text: "Leeds City Council (via bins.felixyeung.com)"
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
    : Array.isArray(raw?.data?.jobs)
      ? raw.data.jobs
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
        row.bin ||
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
