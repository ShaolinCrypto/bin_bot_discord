const appId = process.env.DISCORD_APPLICATION_ID?.trim();
const botToken = process.env.DISCORD_BOT_TOKEN?.trim();
const guildId = process.env.DISCORD_GUILD_ID?.trim();

const commands = [
  {
    name: "bins",
    description: "Show upcoming Leeds bin collection dates",
    dm_permission: false,
    contexts: [0]
  },
  {
    name: "binping",
    description: "Test the Discord interaction endpoint",
    dm_permission: false,
    contexts: [0]
  }
];

if (!appId || !botToken) {
  console.error("Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN.");
  process.exit(1);
}

async function putCommands(label, url) {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  });

  const text = await response.text();
  console.log(`${label}:`, response.status, text);
}

if (guildId) {
  await putCommands(
    "Guild",
    `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  );
} else {
  await putCommands(
    "Global",
    `https://discord.com/api/v10/applications/${appId}/commands`
  );
}
