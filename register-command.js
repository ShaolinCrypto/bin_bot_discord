const APP_ID = process.env.DISCORD_APPLICATION_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const response = await fetch(
  `https://discord.com/api/v10/applications/${APP_ID}/commands`,
  {
    method: "POST",
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      name: "bins",
      description: "Show upcoming Leeds bin collection dates"
    })
  }
);

console.log(response.status, await response.text());
