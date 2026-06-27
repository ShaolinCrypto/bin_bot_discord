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
  inviteUrl: null,
  discordApplication: null,
  botIdentity: null,
  applicationId: null,
  interactionsEndpoint: null
};

const interactionStats = {
  total: 0,
  verified: 0,
  pings: 0,
  commands: 0,
  missingHeaders: 0,
  signatureFailures: 0,
  errors: 0,
  lastAt: null,
  lastPath: null,
  lastCommand: null,
  lastResult: null
};

function env(name) {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getInteractionEndpointUrl() {
  const explicit = env("INTERACTIONS_ENDPOINT_URL");
  if (explicit) return explicit.replace(/\/$/, "");

  const publicUrl =
    env("PUBLIC_URL") || "https://site--bin-bot-discord--5dyfyjhlp7ws.code.run";
  return `${publicUrl.replace(/\/$/, "")}/interactions`;
}

function recordInteraction(event) {
  interactionStats.total += 1;
  interactionStats.lastAt = new Date().toISOString();
  interactionStats.lastPath = event.path;
  interactionStats.lastCommand = event.command ?? null;
  interactionStats.lastResult = event.result;

  if (event.result === "missing_headers") interactionStats.missingHeaders += 1;
  if (event.result === "signature_failed") interactionStats.signatureFailures += 1;
  if (event.result === "verified") interactionStats.verified += 1;
  if (event.result === "ping") interactionStats.pings += 1;
  if (event.result === "command") interactionStats.commands += 1;
  if (event.result === "error") interactionStats.errors += 1;
}

async function fetchBotIdentity(botToken) {
  const response = await fetch("https://discord.com/api/v10/users/@me", {
    headers: {
      Authorization: `Bot ${botToken}`
    }
  });

  const text = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: text
    };
  }

  const bot = JSON.parse(text);

  return {
    ok: true,
    id: bot.id,
    username: bot.username,
    displayName: bot.global_name ?? bot.username
  };
}

async function fetchDiscordApplication(botToken) {
  const response = await fetch("https://discord.com/api/v10/applications/@me", {
    headers: {
      Authorization: `Bot ${botToken}`
    }
  });

  const text = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: text
    };
  }

  const application = JSON.parse(text);

  return {
    ok: true,
    id: application.id,
    name: application.name ?? null,
    interactionsEndpointUrl: application.interactions_endpoint_url ?? null
  };
}

function resolveApplicationId(application) {
  const configuredId = env("DISCORD_APPLICATION_ID");

  if (configuredId && configuredId !== application.id) {
    console.error(
      "DISCORD_APPLICATION_ID does not match the bot token application.",
      `Env has ${configuredId}, bot token belongs to ${application.id}.`,
      "Using the application ID from the bot token."
    );
  }

  return application.id;
}

async function configureInteractionsEndpoint(botToken) {
  const targetUrl = getInteractionEndpointUrl();

  if (!targetUrl) {
    return {
      ok: false,
      skipped: true,
      reason: "No interactions endpoint URL could be determined."
    };
  }

  const current = await fetchDiscordApplication(botToken);

  if (!current.ok) {
    return {
      ok: false,
      targetUrl,
      error: current.error,
      status: current.status
    };
  }

  const response = await fetch("https://discord.com/api/v10/applications/@me", {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      interactions_endpoint_url: targetUrl
    })
  });

  const text = await response.text();

  if (!response.ok) {
    return {
      ok: false,
      targetUrl,
      previousUrl: current.interactionsEndpointUrl,
      status: response.status,
      error: text
    };
  }

  const application = JSON.parse(text);

  return {
    ok: true,
    targetUrl,
    previousUrl: current.interactionsEndpointUrl,
    currentUrl: application.interactions_endpoint_url ?? null,
    revalidated: current.interactionsEndpointUrl === targetUrl
  };
}

async function startup() {
  const botToken = env("DISCORD_BOT_TOKEN");

  startupStatus.botIdentity = botToken
    ? await fetchBotIdentity(botToken)
    : { ok: false, error: "DISCORD_BOT_TOKEN is not set" };

  startupStatus.discordApplication = botToken
    ? await fetchDiscordApplication(botToken)
    : { ok: false, error: "DISCORD_BOT_TOKEN is not set" };

  if (startupStatus.discordApplication.ok) {
    startupStatus.applicationId = resolveApplicationId(startupStatus.discordApplication);
    console.log(
      "Bot:",
      startupStatus.botIdentity.ok
        ? `@${startupStatus.botIdentity.username} (${startupStatus.applicationId})`
        : startupStatus.applicationId
    );
  }

  if (startupStatus.botIdentity.ok === false && startupStatus.botIdentity.status === 401) {
    console.error(
      "DISCORD_BOT_TOKEN is invalid. If you reset the token after renaming the bot, update it in Northflank and redeploy."
    );
  }

  startupStatus.interactionsEndpoint = botToken
    ? await configureInteractionsEndpoint(botToken)
    : { ok: false, skipped: true, reason: "DISCORD_BOT_TOKEN is not set" };

  if (startupStatus.interactionsEndpoint.ok) {
    console.log(
      "Interactions endpoint:",
      startupStatus.interactionsEndpoint.currentUrl ??
        startupStatus.interactionsEndpoint.targetUrl
    );
  } else if (!startupStatus.interactionsEndpoint.skipped) {
    console.error(
      "Interactions endpoint configuration failed:",
      startupStatus.interactionsEndpoint.status,
      startupStatus.interactionsEndpoint.error
    );
  } else if (
    startupStatus.discordApplication.ok &&
    !startupStatus.discordApplication.interactionsEndpointUrl
  ) {
    console.error(
      "Discord has no Interactions Endpoint URL configured. Set PUBLIC_URL in Northflank or add it manually in the Developer Portal."
    );
  }

  try {
    await registerCommands();
  } catch (err) {
    console.error("Command registration crashed:", err);
    startupStatus.commandRegistration = {
      ok: false,
      error: String(err)
    };
  }
}

app.post("/test", (req, res) => {
  console.log("POST /test received");
  res.send("POST test OK");
});

async function handleInteraction(req, res) {
  const path = req.originalUrl;
  console.log("Interaction POST received at", path);

  try {
    const signature = req.header("x-signature-ed25519");
    const timestamp = req.header("x-signature-timestamp");
    const publicKey = env("DISCORD_PUBLIC_KEY");

    if (!signature || !timestamp) {
      console.log("Missing Discord signature headers");
      recordInteraction({ path, result: "missing_headers" });
      return res.status(401).send("Missing signature headers");
    }

    if (!publicKey) {
      console.error("DISCORD_PUBLIC_KEY is not set");
      recordInteraction({ path, result: "error" });
      return res.status(500).send("Server misconfigured");
    }

    const isVerified = nacl.sign.detached.verify(
      Buffer.from(timestamp + req.body.toString("utf8")),
      Buffer.from(signature, "hex"),
      Buffer.from(publicKey, "hex")
    );

    if (!isVerified) {
      console.log("Signature verification failed");
      recordInteraction({ path, result: "signature_failed" });
      return res.status(401).send("Invalid request signature");
    }

    console.log("Signature verified");
    recordInteraction({ path, result: "verified" });

    const interaction = JSON.parse(req.body.toString("utf8"));

    if (interaction.type === DISCORD_PING) {
      recordInteraction({ path, result: "ping" });
      return res.json({ type: DISCORD_PING });
    }

    if (
      interaction.type === APPLICATION_COMMAND &&
      interaction.data?.name === "binping"
    ) {
      console.log("binping command received");
      recordInteraction({ path, command: "binping", result: "command" });

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
      recordInteraction({ path, command: "bins", result: "command" });

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
    recordInteraction({ path, result: "error" });

    if (!res.headersSent) {
      return res.status(500).send("Internal server error");
    }
  }
}

async function sendFollowUp(interaction, data) {
  const appId =
    interaction.application_id ||
    startupStatus.applicationId ||
    env("DISCORD_APPLICATION_ID");

  if (!appId) {
    throw new Error("Application ID is not available");
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
  const configuredEndpoint =
    startupStatus.interactionsEndpoint?.currentUrl ??
    startupStatus.interactionsEndpoint?.targetUrl ??
    startupStatus.discordApplication?.interactionsEndpointUrl ??
    null;

  res.json({
    status: "ok",
    env: {
      DISCORD_PUBLIC_KEY: Boolean(env("DISCORD_PUBLIC_KEY")),
      DISCORD_APPLICATION_ID: Boolean(env("DISCORD_APPLICATION_ID")),
      DISCORD_BOT_TOKEN: Boolean(env("DISCORD_BOT_TOKEN")),
      DISCORD_GUILD_ID: Boolean(env("DISCORD_GUILD_ID")),
      PREMISES_ID: Boolean(env("PREMISES_ID") || env("UPRN")),
      PUBLIC_URL: Boolean(env("PUBLIC_URL")),
      INTERACTIONS_ENDPOINT_URL: Boolean(env("INTERACTIONS_ENDPOINT_URL"))
    },
    discordApplication: startupStatus.discordApplication,
    botIdentity: startupStatus.botIdentity,
    applicationId: startupStatus.applicationId,
    applicationIdMismatch:
      Boolean(env("DISCORD_APPLICATION_ID")) &&
      Boolean(startupStatus.applicationId) &&
      env("DISCORD_APPLICATION_ID") !== startupStatus.applicationId,
    interactionsEndpoint: startupStatus.interactionsEndpoint,
    configuredInteractionsEndpoint: configuredEndpoint,
    interactionStats,
    commandRegistration: startupStatus.commandRegistration,
    inviteUrl: startupStatus.inviteUrl,
    recommendedInteractionsEndpoint:
      getInteractionEndpointUrl() ??
      "https://site--bin-bot-discord--5dyfyjhlp7ws.code.run/interactions",
    notes: [
      "botIdentity.username shows which bot this deployment is running. It should match the bot in your Discord server.",
      "If you renamed the bot or reset its token, update DISCORD_BOT_TOKEN in Northflank. If you created a new app, also update DISCORD_PUBLIC_KEY and DISCORD_APPLICATION_ID.",
      "After /binping, interactionStats.total should increase. If it stays 0, you may be using a different bot in Discord than this deployment.",
      "If signatureFailures increases, DISCORD_PUBLIC_KEY is wrong for this application."
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
  const botToken = env("DISCORD_BOT_TOKEN");
  const guildId = env("DISCORD_GUILD_ID");
  const appId = startupStatus.applicationId || env("DISCORD_APPLICATION_ID");

  startupStatus.inviteUrl = appId
    ? `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot%20applications.commands&permissions=18432`
    : null;

  if (!appId || !botToken) {
    const message =
      "Skipping command registration: missing application ID or bot token.";
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

startupStatus.startedAt = new Date().toISOString();
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  startup().catch(err => {
    console.error("Startup failed:", err);
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
            title: "🗓️ Upcoming bin collections",
            description: "No upcoming collections found.",
            color: EMBED_COLOR
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
          title: "🗓️ Upcoming bin collections",
          description: formatNextCollection(next),
          fields: formatCollectionFields(upcoming),
          color: EMBED_COLOR,
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

function formatDateShort(value) {
  const date = new Date(value);
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: "Europe/London"
  }).format(date);
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    timeZone: "Europe/London"
  }).format(date);
  const month = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    timeZone: "Europe/London"
  }).format(date);

  return `${weekday}, ${day} ${month}`;
}

function formatDate(value) {
  const date = new Date(value);
  const weekday = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    timeZone: "Europe/London"
  }).format(date);
  const rest = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Europe/London"
  }).format(date);

  return `${weekday}, ${rest}`;
}

const EMBED_COLOR = 0x232428;

function binEmoji(type) {
  const t = String(type).toLowerCase();

  if (t.includes("black")) return "<:black_bin:1520236253906472990>";
  if (t.includes("brown")) return "<:brown_bin:1520236296646164620>";
  if (t.includes("green")) return "<:green_bin:1520236335510585446>";

  return "🗑️";
}

function binTypeLabel(type) {
  const t = String(type).toLowerCase();

  if (t.includes("black") || t.includes("general")) return "BLACK";
  if (t.includes("brown")) return "BROWN";
  if (t.includes("green") || t.includes("garden")) return "GREEN";
  if (t.includes("recycl")) return "RECYCLING";

  return String(type).toUpperCase();
}

function formatNextCollection(item) {
  return `Next collection: ${binEmoji(item.type)} **${binTypeLabel(item.type)}** on **${formatDate(item.date)}**`;
}

function formatCollectionFields(collections) {
  const fields = [];
  const rowBreak = { name: "\u200B", value: "\u200B", inline: false };

  for (let i = 0; i < collections.length; i++) {
    const item = collections[i];

    fields.push(
      { name: "Bin", value: binEmoji(item.type), inline: true },
      { name: "Collection", value: formatDateShort(item.date), inline: true }
    );

    if (i < collections.length - 1) {
      fields.push(rowBreak);
    }
  }

  return fields;
}
