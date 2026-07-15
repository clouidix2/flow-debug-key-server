// Flow Debug key-generation Discord bot
//
// Slash commands:
//   /flowkey generate duration:<e.g. 1day, 1week, 1month, 5hours, forever> nickname:<label>
//   /flowkey terminate nickname:<label>
//
// Requires Node 18+ (built-in fetch). Run "npm install" then "npm start".
//
// Environment variables needed (set these in your hosting platform, or a .env file with dotenv):
//   DISCORD_TOKEN     - your bot's token from the Discord Developer Portal
//   DISCORD_CLIENT_ID - your bot's application (client) ID
//   DISCORD_GUILD_ID  - (optional) your server's ID, for instant command registration during testing.
//                       Omit this for global commands (takes up to an hour to propagate).
//   KEY_SERVER_URL    - base URL of your key server, e.g. https://flow-debug-production.up.railway.app
//   BOT_SECRET        - must match the BOT_SECRET set on the key server
//   ALLOWED_ROLE_ID   - (optional) Discord role ID required to use /flowkey. If unset, anyone can use it -
//                       strongly recommend setting this so random server members can't generate keys.

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const API_URL = process.env.KEY_SERVER_URL;
const BOT_SECRET = process.env.BOT_SECRET;
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;

if (!TOKEN || !CLIENT_ID || !API_URL || !BOT_SECRET) {
    console.error("Missing required environment variables. Need DISCORD_TOKEN, DISCORD_CLIENT_ID, KEY_SERVER_URL, BOT_SECRET.");
    process.exit(1);
}

const flowkeyCommand = new SlashCommandBuilder()
    .setName("flowkey")
    .setDescription("Manage Flow Debug license keys")
    .addSubcommand((sub) =>
        sub
            .setName("generate")
            .setDescription("Generate a new license key")
            .addStringOption((opt) =>
                opt
                    .setName("duration")
                    .setDescription("e.g. 1day, 1week, 1month, 5hours, or forever")
                    .setRequired(true)
            )
            .addStringOption((opt) =>
                opt
                    .setName("nickname")
                    .setDescription("Label to identify this key later (e.g. the person's name)")
                    .setRequired(true)
            )
    )
    .addSubcommand((sub) =>
        sub
            .setName("terminate")
            .setDescription("Revoke all keys with a given nickname")
            .addStringOption((opt) =>
                opt
                    .setName("nickname")
                    .setDescription("The nickname of the key(s) to terminate")
                    .setRequired(true)
            )
    );

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const body = [flowkeyCommand.toJSON()];

    if (GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
        console.log("Registered /flowkey as a guild command (instant).");
    } else {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
        console.log("Registered /flowkey as a global command (can take up to an hour to show up).");
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "flowkey") return;

    if (ALLOWED_ROLE_ID && !interaction.member.roles.cache.has(ALLOWED_ROLE_ID)) {
        return interaction.reply({ content: "You don't have permission to use this.", ephemeral: true });
    }

    const sub = interaction.options.getSubcommand();

    try {
        if (sub === "generate") {
            const duration = interaction.options.getString("duration");
            const nickname = interaction.options.getString("nickname");

            await interaction.deferReply({ ephemeral: true });

            const res = await fetch(`${API_URL}/keys/generate`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-bot-secret": BOT_SECRET },
                body: JSON.stringify({ nickname, duration, discordUserId: interaction.user.id }),
            });

            const data = await res.json();

            if (!res.ok) {
                return interaction.editReply(`Failed to generate key: ${data.error || "unknown error"}`);
            }

            const expiryText = data.expiresAt
                ? `<t:${Math.floor(data.expiresAt / 1000)}:F>`
                : "Never (permanent)";

            return interaction.editReply(
                `**Key generated for "${nickname}"**\n` +
                    `Key: \`${data.key}\`\n` +
                    `Expires: ${expiryText}\n` +
                    `This key will lock to whoever's computer uses it first - only share it with the intended person.`
            );
        }

        if (sub === "terminate") {
            const nickname = interaction.options.getString("nickname");

            await interaction.deferReply({ ephemeral: true });

            const res = await fetch(`${API_URL}/keys/terminate`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "x-bot-secret": BOT_SECRET },
                body: JSON.stringify({ nickname }),
            });

            const data = await res.json();

            if (!res.ok) {
                return interaction.editReply(`Failed to terminate: ${data.error || "unknown error"}`);
            }

            return interaction.editReply(`Terminated ${data.revokedCount} key(s) with nickname "${nickname}".`);
        }
    } catch (e) {
        console.error(e);
        const msg = `Something went wrong: ${e.message}`;
        if (interaction.deferred) {
            await interaction.editReply(msg);
        } else {
            await interaction.reply({ content: msg, ephemeral: true });
        }
    }
});

client.once("ready", () => console.log(`Logged in as ${client.user.tag}`));

registerCommands()
    .then(() => client.login(TOKEN))
    .catch((e) => {
        console.error("Failed to register commands:", e);
        process.exit(1);
    });
