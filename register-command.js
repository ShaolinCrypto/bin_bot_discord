const appId = process.env.DISCORD_APPLICATION_ID?.trim();
const botToken = process.env.DISCORD_BOT_TOKEN?.trim();

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

const response = await fetch(
  `https://discord.com/api/v10/applications/${appId}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  }
);

console.log("Global:", response.status, await response.text());
