// Flow Debug key-generation Discord bot
//
// Slash commands (all require the ALLOWED_ROLE_ID role, including help):
//   /flowkey generate @user plan:<Lifetime|Monthly>
//   /flowkey terminate [@user] [key:<string>] reason:<text>   (provide either user or key)
//   /flowkey upgrade @user
//   /flowkey check @user
//   /flowkey list
//   /flowkey help
//
// Background job: every 15 minutes, checks for monthly keys that were
// generated 7+ days ago and never activated (boundDeviceId still null),
// revokes them, and DMs the user that their key was terminated for non-use.
//
// Requires Node 18+ (built-in fetch). Run "npm install" then "npm start".
//
// Environment variables:
//   DISCORD_TOKEN     - your bot's token
//   DISCORD_CLIENT_ID - your bot's application ID
//   DISCORD_GUILD_ID  - (optional) guild ID for instant command registration
//   KEY_SERVER_URL    - public URL of your key server
//   BOT_SECRET        - must match the BOT_SECRET set on the key server
//   ALLOWED_ROLE_ID   - (optional) Discord role ID required to use any /flowkey subcommand

const {
    Client,
    GatewayIntentBits,
    SlashCommandBuilder,
    REST,
    Routes,
    MessageFlags,
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const BOT_SECRET = process.env.BOT_SECRET;
const ALLOWED_ROLE_ID = process.env.ALLOWED_ROLE_ID;

// Normalize KEY_SERVER_URL so a bare domain (missing "https://") doesn't
// silently break every fetch() call with a confusing "Failed to parse URL" error.
let API_URL = process.env.KEY_SERVER_URL;
if (API_URL && !/^https?:\/\//i.test(API_URL)) {
    console.warn(`KEY_SERVER_URL "${API_URL}" is missing a protocol - assuming https://`);
    API_URL = `https://${API_URL}`;
}
if (API_URL) {
    API_URL = API_URL.replace(/\/+$/, ""); // strip any trailing slash too, same reasoning
}

if (!TOKEN || !CLIENT_ID || !API_URL || !BOT_SECRET) {
    console.error("Missing required environment variables. Need DISCORD_TOKEN, DISCORD_CLIENT_ID, KEY_SERVER_URL, BOT_SECRET.");
    process.exit(1);
}

const UNUSED_KEY_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // check every 15 minutes
const UNUSED_KEY_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------- helpers ----------

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(id);
    }
}

async function dmUser(user, content) {
    try {
        return await user.send(content);
    } catch (err) {
        if (err.code === 50007) {
            console.log(`Cannot DM ${user.tag} (${user.id}): DMs closed`);
            return null;
        }
        throw err;
    }
}

async function apiPost(pathName, body) {
    const res = await fetchWithTimeout(`${API_URL}${pathName}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-bot-secret": BOT_SECRET },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { ok: res.ok, data };
}

async function apiGet(pathName) {
    const res = await fetchWithTimeout(`${API_URL}${pathName}`, {
        headers: { "x-bot-secret": BOT_SECRET },
    });
    const data = await res.json();
    return { ok: res.ok, data };
}

// Formats a millisecond duration as e.g. "13d 12h", "2h", "27d 5h", "45m"
function formatTimeframe(ms) {
    if (ms <= 0) return "0m";

    const totalMinutes = Math.floor(ms / (60 * 1000));
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const minutes = totalMinutes % 60;

    if (days > 0) {
        return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
    }
    if (hours > 0) {
        return minutes > 0 && hours < 1 ? `${hours}h ${minutes}m` : `${hours}h`;
    }
    return `${minutes}m`;
}

function buildKeyDm({ key, plan, expiresAt }) {
    const planBlock = plan === "lifetime"
        ? "Lifetime"
        : `Monthly - expires in ${formatTimeframe(expiresAt - Date.now())}`;

    return (
        `:closed_lock_with_key: **Flow Addon License Key**\n\n` +
        `**Your personal key:**\n\`\`\`\n${key}\n\`\`\`\n` +
        `**Plan**\n\`\`\`\n${planBlock}\n\`\`\`\n` +
        `**To activate in-game:**\n\`\`\`\nGoto the Flow Key Module and input key. Then activate the module.\n\`\`\`\n` +
        `> :warning: Do not share this key. It is tied to your HWID and can be revoked at any time.`
    );
}

const HELP_MESSAGE =
    ":envelope_with_arrow: **How to enable DMs so I can send you your key**\n\n" +
    "1. Open Discord's **User Settings** (gear icon near your name).\n" +
    "2. Go to **Privacy & Safety**.\n" +
    "3. Turn on **\"Allow direct messages from server members\"** for this server.\n" +
    "   - On mobile: Settings → Privacy & Safety → same toggle.\n" +
    "4. If you'd previously blocked the bot by accident, make sure it isn't in your **Blocked Users** list.\n" +
    "5. Ask a staff member to run `/flowkey generate` for you again once DMs are enabled.\n\n" +
    "If DMs are already on and you still aren't receiving anything, mutual servers or account age restrictions can sometimes block bot DMs - let staff know and they can send the key another way.";

// ---------- slash command definitions ----------

const flowkeyCommand = new SlashCommandBuilder()
    .setName("flowkey")
    .setDescription("Manage Flow Debug license keys")
    .addSubcommand((sub) =>
        sub
            .setName("generate")
            .setDescription("Generate a license key for a user")
            .addUserOption((opt) => opt.setName("user").setDescription("The user to generate a key for").setRequired(true))
            .addStringOption((opt) =>
                opt
                    .setName("plan")
                    .setDescription("Key plan type")
                    .setRequired(true)
                    .addChoices(
                        { name: "Lifetime", value: "forever" },
                        { name: "Monthly", value: "1month" }
                    )
            )
    )
    .addSubcommand((sub) =>
        sub
            .setName("terminate")
            .setDescription("Terminate a license key, by user or by the key itself")
            .addStringOption((opt) => opt.setName("reason").setDescription("Reason for termination").setRequired(true))
            .addUserOption((opt) => opt.setName("user").setDescription("The user whose key to terminate").setRequired(false))
            .addStringOption((opt) => opt.setName("key").setDescription("The exact key string to terminate").setRequired(false))
    )
    .addSubcommand((sub) =>
        sub
            .setName("upgrade")
            .setDescription("Upgrade a user's monthly key to a lifetime key")
            .addUserOption((opt) => opt.setName("user").setDescription("The user to upgrade").setRequired(true))
    )
    .addSubcommand((sub) =>
        sub
            .setName("check")
            .setDescription("Check a user's current license status")
            .addUserOption((opt) => opt.setName("user").setDescription("The user to check").setRequired(true))
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List every key on record and its status"))
    .addSubcommand((sub) => sub.setName("help").setDescription("Shows instructions for enabling DMs (postable in support tickets)"));

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    const body = [flowkeyCommand.toJSON()];

    // Wipe both registries first so stale commands from earlier deploys (under
    // a different GUILD_ID setting) can never linger as duplicates.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    if (GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: [] });
    }

    if (GUILD_ID) {
        await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body });
        console.log("Cleared old commands and registered /flowkey as a guild command (instant).");
    } else {
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
        console.log("Cleared old commands and registered /flowkey as a global command (can take up to an hour to show up).");
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "flowkey") return;

    if (!interaction.inGuild()) {
        return interaction.reply({ content: "This command only works in servers.", flags: MessageFlags.Ephemeral });
    }

    if (ALLOWED_ROLE_ID && !interaction.member?.roles?.cache?.has(ALLOWED_ROLE_ID)) {
        return interaction.reply({ content: "You don't have permission to use this.", flags: MessageFlags.Ephemeral });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === "help") {
        return interaction.reply({ content: HELP_MESSAGE }); // public - visible to the whole channel
    }

    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (deferErr) {
        console.error("Failed to defer reply:", deferErr);
        return;
    }

    try {
        if (sub === "generate") {
            const targetUser = interaction.options.getUser("user", true);
            const plan = interaction.options.getString("plan", true); // "forever" or "1month"

            const { ok, data } = await apiPost("/keys/generate", {
                discordUserId: targetUser.id,
                nickname: targetUser.username,
                duration: plan,
            });

            if (!ok) {
                return interaction.editReply(`Failed to generate key: ${data.error || "server error"}`);
            }

            const planName = plan === "forever" ? "lifetime" : "monthly";
            const dmContent = buildKeyDm({ key: data.key, plan: planName, expiresAt: data.expiresAt });
            const dmSent = await dmUser(targetUser, dmContent);

            const expiryText = data.expiresAt ? `<t:${Math.floor(data.expiresAt / 1000)}:F>` : "Never (permanent)";

            return interaction.editReply(
                `✅ **Key generated for ${targetUser}**\n` +
                `Plan: \`${planName}\`\n` +
                `Key: \`${data.key}\`\n` +
                `Expires: ${expiryText}\n` +
                `DM sent: ${dmSent ? "✅" : "❌ (user has DMs closed - use /flowkey help in this channel to guide them)"}`
            );
        }

        if (sub === "terminate") {
            const targetUser = interaction.options.getUser("user", false);
            const targetKey = interaction.options.getString("key", false);
            const reason = interaction.options.getString("reason", true);

            if (!targetUser && !targetKey) {
                return interaction.editReply("Provide either a user or a key to terminate.");
            }

            if (targetKey) {
                // Key-mode: look up who it belongs to (if anyone) so we can DM them.
                const list = await apiGet("/keys/list");
                const entry = list.ok ? list.data.keys.find((k) => k.key === targetKey) : null;

                if (!entry) {
                    return interaction.editReply(`No key found matching \`${targetKey}\`.`);
                }

                const { ok, data } = await apiPost("/keys/revoke-by-key", { key: targetKey });

                if (!ok || !data.revoked) {
                    return interaction.editReply(`That key was already revoked or something went wrong.`);
                }

                let dmSent = null;
                if (entry.createdFor) {
                    try {
                        const owner = await client.users.fetch(entry.createdFor);
                        const dmContent =
                            `:closed_lock_with_key: **Flow Addon License Key**\n\n**Your Personal key has been terminated**\n` +
                            `\`\`\`\n~~${targetKey}~~\n\`\`\`\n` +
                            `**Reason**\n\`\`\`\n${reason}\n\`\`\`\n` +
                            `> :warning: If you think this is wrong please open a support ticket in our discord`;
                        dmSent = await dmUser(owner, dmContent);
                    } catch (e) {
                        dmSent = null;
                    }
                }

                return interaction.editReply(
                    `🔒 **Terminated key** \`${targetKey}\`\n` +
                    `Reason: \`${reason}\`\n` +
                    `DM sent: ${dmSent ? "✅" : "❌ (no owner on record or DMs closed)"}`
                );
            }

            // User-mode (original behavior)
            const status = await apiGet(`/keys/status/${targetUser.id}`);
            if (!status.ok || !status.data.hasValidKey) {
                return interaction.editReply(`User doesn't have a valid license key`);
            }

            const { ok, data } = await apiPost("/keys/terminate", {
                discordUserId: targetUser.id,
                nickname: targetUser.username,
            });

            if (!ok) {
                return interaction.editReply(`Failed to terminate: ${data.error || "server error"}`);
            }

            const dmContent =
                `:closed_lock_with_key: **Flow Addon License Key**\n\n**Your Personal key has been terminated**\n` +
                `\`\`\`\n~~${status.data.key}~~\n\`\`\`\n` +
                `**Reason**\n\`\`\`\n${reason}\n\`\`\`\n` +
                `> :warning: If you think this is wrong please open a support ticket in our discord`;

            const dmSent = await dmUser(targetUser, dmContent);

            return interaction.editReply(
                `🔒 **Terminated ${data.revokedCount || 0} key(s) for ${targetUser}**\n` +
                `Reason: \`${reason}\`\n` +
                `DM sent: ${dmSent ? "✅" : "❌ (user has DMs closed)"}`
            );
        }

        if (sub === "upgrade") {
            const targetUser = interaction.options.getUser("user", true);

            const status = await apiGet(`/keys/status/${targetUser.id}`);
            if (!status.ok) {
                return interaction.editReply("Failed to look up user's key status.");
            }

            if (!status.data.hasValidKey) {
                return interaction.editReply("User doesn't have a valid license key to upgrade.");
            }

            if (status.data.plan === "lifetime") {
                return interaction.editReply("User already has a valid lifetime key.");
            }

            // Revoke the old monthly key, issue a fresh lifetime one.
            await apiPost("/keys/revoke-by-key", { key: status.data.key });

            const { ok, data } = await apiPost("/keys/generate", {
                discordUserId: targetUser.id,
                nickname: targetUser.username,
                duration: "forever",
            });

            if (!ok) {
                return interaction.editReply(`Failed to generate upgraded key: ${data.error || "server error"}`);
            }

            const dmContent = buildKeyDm({ key: data.key, plan: "lifetime", expiresAt: null });
            const dmSent = await dmUser(targetUser, dmContent);

            return interaction.editReply(
                `✅ **Upgraded ${targetUser} to lifetime**\n` +
                `New key: \`${data.key}\`\n` +
                `DM sent: ${dmSent ? "✅" : "❌ (user has DMs closed - use /flowkey help in this channel to guide them)"}`
            );
        }

        if (sub === "check") {
            const targetUser = interaction.options.getUser("user", true);

            const status = await apiGet(`/keys/status/${targetUser.id}`);
            if (!status.ok) {
                return interaction.editReply("Failed to look up user's key status.");
            }

            if (!status.data.hasValidKey) {
                return interaction.editReply(`${targetUser} has no valid license :x:`);
            }

            if (status.data.plan === "lifetime") {
                return interaction.editReply(`${targetUser} has a valid lifetime license`);
            }

            const timeLeft = formatTimeframe(status.data.expiresAt - Date.now());
            return interaction.editReply(`${targetUser} has a valid monthly license. Expires in ${timeLeft}`);
        }

        if (sub === "list") {
            const list = await apiGet("/keys/list");
            if (!list.ok) {
                return interaction.editReply("Failed to fetch key list.");
            }

            if (list.data.keys.length === 0) {
                return interaction.editReply("Available Keys.\n\n(none on record)");
            }

            const lines = list.data.keys.map((entry) => {
                const who = entry.createdFor ? `<@${entry.createdFor}>` : "Unknown";
                const plan = entry.expiresAt === null ? "Lifetime" : "Monthly";
                const hwidLinked = entry.boundDeviceId ? "Yes" : "No";
                const revokedTag = entry.revoked ? " (revoked)" : "";
                return `${who} ${plan} ${entry.key} ${hwidLinked}${revokedTag}`;
            });

            // Discord messages cap at 2000 chars - chunk into multiple replies if needed.
            const header = "Available Keys.\n";
            let chunks = [];
            let current = header;

            for (const line of lines) {
                if ((current + line + "\n").length > 1900) {
                    chunks.push(current);
                    current = "";
                }
                current += line + "\n";
            }
            if (current.length > 0) chunks.push(current);

            await interaction.editReply(chunks[0]);
            for (let i = 1; i < chunks.length; i++) {
                await interaction.followUp({ content: chunks[i], flags: MessageFlags.Ephemeral });
            }
            return;
        }
    } catch (e) {
        console.error("Command error:", e);
        const msg = `Something went wrong: ${e.message || "request timed out or server unreachable"}`;
        try {
            await interaction.editReply(msg);
        } catch (editErr) {
            console.error("Failed to edit reply:", editErr);
        }
    }
});

// ---------- background sweep: revoke unused monthly keys after 7 days ----------

async function sweepUnusedKeys() {
    try {
        const { ok, data } = await apiGet("/keys/list");
        if (!ok) {
            console.error("Sweep: failed to fetch key list");
            return;
        }

        const now = Date.now();

        for (const entry of data.keys) {
            const isMonthly = entry.expiresAt !== null;
            const neverUsed = !entry.boundDeviceId;
            const oldEnough = now - entry.createdAt > UNUSED_KEY_GRACE_PERIOD_MS;

            if (isMonthly && neverUsed && oldEnough && !entry.revoked) {
                const revokeResult = await apiPost("/keys/revoke-by-key", { key: entry.key });
                if (!revokeResult.ok || !revokeResult.data.revoked) continue;

                if (entry.createdFor) {
                    try {
                        const user = await client.users.fetch(entry.createdFor);
                        await dmUser(
                            user,
                            `<@${entry.createdFor}>. You have not used the license key within 7 days and the license has been terminated. Please make a support ticket in our discord`
                        );
                    } catch (e) {
                        console.error(`Sweep: failed to notify user ${entry.createdFor}:`, e.message);
                    }
                }

                console.log(`Sweep: revoked unused key ${entry.key} (createdFor: ${entry.createdFor})`);
            }
        }
    } catch (e) {
        console.error("Sweep error:", e);
    }
}

client.once("ready", () => {
    console.log(`Logged in as ${client.user.tag}`);
    sweepUnusedKeys(); // run once on startup too, not just after the first interval
    setInterval(sweepUnusedKeys, UNUSED_KEY_SWEEP_INTERVAL_MS);
});

registerCommands()
    .then(() => client.login(TOKEN))
    .catch((e) => {
        console.error("Failed to register commands:", e);
        process.exit(1);
    });
