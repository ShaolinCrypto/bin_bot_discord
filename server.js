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

const COMMANDS = [
  {
    name: "bins",
    description: "Show upcoming Leeds bin collection dates"
  },
  {
    name: "binping",
    description: "Test the Discord interaction endpoint"
  }
];

let startupStatus = {
  startedAt: null,
  commandRegistration: null,
  inviteUrl: null
};

function env(name) {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

app.post("/test", (req, res) => {
  console.log("POST /test received");
  res.send("POST test OK");
});

async function handleInteraction(req, res) {
  console.log("Interaction POST received at", req.originalUrl);

  try {
    const signature = req.header("x-signature-ed25519");
    const timestamp = req.header("x-signature-timestamp");
    const publicKey = env("DISCORD_PUBLIC_KEY");

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
  const appId = env("DISCORD_APPLICATION_ID");

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

app.get("/health", (_, res) => {
  res.json({
    status: "ok",
    env: {
      DISCORD_PUBLIC_KEY: Boolean(env("DISCORD_PUBLIC_KEY")),
      DISCORD_APPLICATION_ID: Boolean(env("DISCORD_APPLICATION_ID")),
      DISCORD_BOT_TOKEN: Boolean(env("DISCORD_BOT_TOKEN")),
      DISCORD_GUILD_ID: Boolean(env("DISCORD_GUILD_ID")),
      PREMISES_ID: Boolean(env("PREMISES_ID") || env("UPRN"))
    },
    commandRegistration: startupStatus.commandRegistration,
    inviteUrl: startupStatus.inviteUrl,
    notes: [
      "Set Interactions Endpoint URL in Discord Developer Portal to this service URL (root or /interactions).",
      "Global slash commands can take up to 1 hour to appear; guild commands are instant when DISCORD_GUILD_ID matches your server.",
      "Re-invite the bot with applications.commands scope if commands do not appear."
    ]
  });
});

async function putCommands(url, botToken) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(COMMANDS)
  });

  const text = await response.text();
  let commands = [];

  if (response.ok) {
    try {
      commands = JSON.parse(text);
    } catch {
      commands = [];
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body: text,
    commandNames: commands.map(command => command.name)
  };
}

async function registerCommands() {
  const appId = env("DISCORD_APPLICATION_ID");
  const botToken = env("DISCORD_BOT_TOKEN");
  const guildId = env("DISCORD_GUILD_ID");

  startupStatus.inviteUrl = appId
    ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=18432`
    : null;

  if (!appId || !botToken) {
    const message = "Skipping command registration: missing DISCORD_APPLICATION_ID or DISCORD_BOT_TOKEN.";
    console.error(message);
    startupStatus.commandRegistration = {
      ok: false,
      error: message
    };
    return;
  }

  console.log("Registering slash commands");

  const globalResult = await putCommands(
    `https://discord.com/api/v10/applications/${appId}/commands`,
    botToken
  );

  console.log(
    "Global command registration:",
    globalResult.status,
    globalResult.commandNames.join(", ") || globalResult.body
  );

  const results = {
    ok: globalResult.ok,
    global: globalResult
  };

  if (guildId) {
    const guildResult = await putCommands(
      `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`,
      botToken
    );

    console.log(
      "Guild command registration:",
      guildResult.status,
      guildResult.commandNames.join(", ") || guildResult.body
    );

    results.guild = guildResult;
    results.ok = globalResult.ok && guildResult.ok;

    if (!guildResult.ok) {
      console.error(
        "Guild command registration failed. Check DISCORD_GUILD_ID matches the server where the bot was invited."
      );
    }
  } else {
    console.log(
      "DISCORD_GUILD_ID not set; only global commands were registered (may take up to 1 hour to appear)."
    );
  }

  if (!globalResult.ok) {
    console.error("Global command registration failed:", globalResult.status, globalResult.body);
  }

  if (startupStatus.inviteUrl) {
    console.log("Bot invite URL (must include applications.commands):", startupStatus.inviteUrl);
  }

  startupStatus.commandRegistration = results;
}

registerCommands()
  .catch(err => {
    console.error("Command registration crashed:", err);
    startupStatus.commandRegistration = {
      ok: false,
      error: String(err)
    };
  })
  .finally(() => {
    startupStatus.startedAt = new Date().toISOString();
    app.listen(PORT, () => {
      console.log(`Listening on port ${PORT}`);
    });
  });

async function getBinsEmbed() {
  const premisesId = env("PREMISES_ID") || env("UPRN");

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
