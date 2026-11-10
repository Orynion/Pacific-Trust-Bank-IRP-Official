import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

/**
 * SQLite/LibSQL schema for applications and application settings.
 */
export const applicationSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS application_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    username TEXT NOT NULL,
    answers_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected')),
    reviewed_by TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_applications_user_status
    ON applications (user_id, status)`,
];

/**
 * In-memory active application questionnaire sessions: userId -> sessionObject
 */
export const activeApplicationSessions = new Map();

/**
 * Questionnaire questions for Bank Manager / Bank Teller role applications.
 */
export const APPLICATION_QUESTIONS = [
  {
    id: "roblox_identity",
    prompt: "1️⃣ What is your exact Roblox Username and User ID (e.g., `PlayerName_123` / `12345678`)?",
  },
  {
    id: "discord_identity",
    prompt: "2️⃣ What is your Discord username and tag (e.g., `username#0001` or `@username`)?",
  },
  {
    id: "role_desired",
    prompt: "3️⃣ Which position are you applying for? Reply with **Bank Manager** or **Bank Teller**.",
  },
  {
    id: "experience",
    prompt: "4️⃣ Summarize your relevant banking, moderation, or roleplay experience in Emergency Hamburg / Roblox roleplay servers.",
  },
  {
    id: "availability",
    prompt: "5️⃣ What is your timezone and how many hours per week can you actively dedicate to PTB bank operations?",
  },
  {
    id: "scenario",
    prompt: "6️⃣ Scenario: A citizen requests a 50,000 credit withdrawal without staff approval. How do you handle this request?",
  },
];

/**
 * Slash command definition for /application
 */
export const applicationCommand = new SlashCommandBuilder()
  .setName("application")
  .setDescription("Manage or submit bank staff applications (Manager / Teller)")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Admin: Open or close staff applications")
      .addStringOption((o) =>
        o.setName("action")
          .setDescription("Choose whether to open or close applications")
          .setRequired(true)
          .addChoices(
            { name: "open", value: "open" },
            { name: "close", value: "close" },
          ))
      .addChannelOption((o) =>
        o.setName("channel")
          .setDescription("Optional channel to post the public application panel when opening")
          .setRequired(false))
  );

/**
 * Checks if applications are currently open in settings.
 * @param {any} db
 * @returns {Promise<boolean>}
 */
export async function areApplicationsOpen(db) {
  if (!db || typeof db.execute !== "function") return false;
  try {
    const res = await db.execute({
      sql: "SELECT value FROM application_settings WHERE key = 'status' LIMIT 1",
      args: [],
    });
    if (res.rows?.length > 0) {
      return res.rows[0].value === "open";
    }
  } catch {}
  return false;
}

/**
 * Gets the designated review channel ID from settings.
 * @param {any} db
 * @returns {Promise<string|null>}
 */
export async function getApplicationReviewChannelId(db) {
  if (!db || typeof db.execute !== "function") return null;
  try {
    const res = await db.execute({
      sql: "SELECT value FROM application_settings WHERE key = 'review_channel_id' LIMIT 1",
      args: [],
    });
    if (res.rows?.length > 0) {
      return res.rows[0].value || null;
    }
  } catch {}
  return null;
}

/**
 * Handles /application status:open / close command.
 * @param {any} db
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationCommand(db, interaction) {
  const hasAdmin = Boolean(
    interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );

  if (!hasAdmin) {
    return interaction.reply({
      content: "# Access Denied\nOnly server administrators can manage staff applications.\n-# Pacific Trust Bank • Staff Administration",
      flags: MessageFlags.Ephemeral,
    });
  }

  const action = interaction.options.getString("action");
  const targetChannel = interaction.options.getChannel("channel") || interaction.channel;

  await db.execute({
    sql: "INSERT OR REPLACE INTO application_settings (key, value) VALUES ('status', ?)",
    args: [action],
  });

  if (action === "open" && targetChannel) {
    await db.execute({
      sql: "INSERT OR REPLACE INTO application_settings (key, value) VALUES ('review_channel_id', ?)",
      args: [interaction.channelId],
    });

    const embed = new EmbedBuilder()
      .setColor(0x0B3D2E)
      .setTitle("📋 Pacific Trust Bank | Bank Staff Applications")
      .setDescription(
        "**Applications for Bank Manager and Bank Teller are now OPEN!**\n\n" +
        "We are looking for dedicated, professional roleplayers to manage citizen accounts, process deposits/withdrawals, and uphold Pacific Trust Bank ledger policies.\n\n" +
        "Click the button below to start your private application questionnaire in Direct Messages."
      )
      .addFields(
        { name: "🏦 Positions Available", value: "• **Bank Manager**: Oversees ledger audits, staff operations, and approvals.\n• **Bank Teller**: Handles citizen deposits, withdrawals, and customer service." },
        { name: "🔒 Requirements", value: "• Active Emergency Hamburg player\n• Professional conduct and reliable availability" }
      )
      .setFooter({ text: "Pacific Trust Bank • Official Staff Application" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("app:apply_rep")
        .setLabel("📝 Apply for Bank Staff")
        .setStyle(ButtonStyle.Success)
        .setEmoji("📋")
    );

    try {
      await targetChannel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error("[PTB Applications] Could not post public application panel:", err);
    }
  }

  const statusText = action === "open" ? "🟢 OPENED" : "🔴 CLOSED";
  return interaction.reply({
    content: `# Applications Updated\nStaff applications are now **${statusText}**.\n-# Pacific Trust Bank • Staff Administration`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handles clicks on the "Apply for Bank Staff" button (app:apply_rep).
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationApplyButton(db, interaction) {
  if (interaction.customId !== "app:apply_rep") return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  const isOpen = await areApplicationsOpen(db);
  if (!isOpen) {
    return interaction.editReply({
      content: "# Applications Closed\nBank staff applications are currently closed. Please check back later.\n-# Pacific Trust Bank • Staff Application",
    });
  }

  const userId = interaction.user.id;

  // Check if user already has a pending application
  try {
    const existing = await db.execute({
      sql: "SELECT id FROM applications WHERE user_id = ? AND status = 'pending' LIMIT 1",
      args: [userId],
    });
    if (existing.rows?.length > 0) {
      return interaction.editReply({
        content: "# Application Pending\nYou already have a pending staff application under review. Please wait for staff to review your submission.\n-# Pacific Trust Bank • Staff Application",
      });
    }
  } catch {}

  if (activeApplicationSessions.has(userId)) {
    return interaction.editReply({
      content: "# Questionnaire Active\nYou already have an active application questionnaire session open in your Direct Messages. Check your DMs to complete it (or type `cancel` to abort).\n-# Pacific Trust Bank • Staff Application",
    });
  }

  // Attempt to send first DM prompt
  try {
    const dmChannel = await interaction.user.createDM();
    const firstQ = APPLICATION_QUESTIONS[0];

    activeApplicationSessions.set(userId, {
      currentIndex: 0,
      answers: {},
      createdAt: Date.now(),
    });

    const introMsg = [
      "# 📋 Pacific Trust Bank | Staff Application",
      "Welcome to the application process for **Bank Manager / Bank Teller**!",
      "Please answer the following questions honestly. You can type `cancel` at any time to abort this questionnaire.",
      "",
      `**${firstQ.prompt}**`,
      "",
      "-# Pacific Trust Bank • Confidential Application DM",
    ].join("\n");

    await dmChannel.send({ content: introMsg });

    return interaction.editReply({
      content: "# Questionnaire Started\nI have sent you a Direct Message with the first application question! Please check your DMs.\n-# Pacific Trust Bank • Staff Application",
    });
  } catch (err) {
    console.error("[PTB Applications] Could not open DM with user:", err);
    return interaction.editReply({
      content: "⚠️ **Direct Messages Closed**: I could not send you a Direct Message. Please enable direct messages from server members and click the apply button again.",
    });
  }
}

/**
 * Handles incoming DM messages from users completing active application sessions.
 * @param {any} db
 * @param {import("discord.js").Message} message
 * @returns {Promise<boolean>} returns true if the message was handled as part of an application session
 */
export async function handleApplicationMessageCreate(db, message) {
  if (message.author.bot || message.guild) return false;

  const userId = message.author.id;
  const session = activeApplicationSessions.get(userId);
  if (!session) return false;

  const content = message.content?.trim() || "";
  if (/^cancel$/i.test(content)) {
    activeApplicationSessions.delete(userId);
    await message.reply("❌ **Application Cancelled**. Your questionnaire session has been discarded.").catch(() => {});
    return true;
  }

  const currentQ = APPLICATION_QUESTIONS[session.currentIndex];
  session.answers[currentQ.id] = content;
  session.currentIndex++;

  if (session.currentIndex < APPLICATION_QUESTIONS.length) {
    const nextQ = APPLICATION_QUESTIONS[session.currentIndex];
    await message.reply(nextQ.prompt).catch(() => {});
    return true;
  }

  // Questionnaire complete! Persist to DB and notify staff
  activeApplicationSessions.delete(userId);

  const answersJson = JSON.stringify(session.answers);
  let appId;
  try {
    const insertRes = await db.execute({
      sql: "INSERT INTO applications (user_id, username, answers_json, status) VALUES (?, ?, ?, 'pending')",
      args: [userId, message.author.tag || message.author.username, answersJson],
    });
    appId = Number(insertRes.lastInsertRowid);
    if (appId === undefined || appId === null) {
      const idRes = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
      appId = Number(idRes.rows[0].id);
    }
  } catch (dbErr) {
    console.error("[PTB Applications] Failed to save application to database:", dbErr);
    await message.reply("⚠️ There was an error saving your application to the database. Please try again later.").catch(() => {});
    return true;
  }

  await message.reply(
    "🎉 **Application Submitted Successfully!**\n" +
    "Thank you for applying to join the Pacific Trust Bank staff team. Your submission has been forwarded to bank administrators for review."
  ).catch(() => {});

  // Forward review embed to Staff Review Channel
  try {
    const reviewChannelId = await getApplicationReviewChannelId(db);
    if (reviewChannelId && message.client?.channels) {
      const reviewChannel = await message.client.channels.fetch(reviewChannelId).catch(() => null);
      if (reviewChannel && typeof reviewChannel.send === "function") {
        const answers = session.answers;
        const reviewEmbed = new EmbedBuilder()
          .setColor(0x2563EB)
          .setTitle(`📋 New Staff Application #${appId}`)
          .setDescription(`Applicant: <@${userId}> (\`${message.author.tag || message.author.username}\`)`)
          .addFields(
            { name: "1️⃣ Roblox Identity", value: answers.roblox_identity || "N/A" },
            { name: "2️⃣ Discord Identity", value: answers.discord_identity || "N/A" },
            { name: "3️⃣ Position Desired", value: answers.role_desired || "N/A" },
            { name: "4️⃣ Experience", value: answers.experience || "N/A" },
            { name: "5️⃣ Availability", value: answers.availability || "N/A" },
            { name: "6️⃣ Scenario Response", value: answers.scenario || "N/A" },
          )
          .setTimestamp()
          .setFooter({ text: `Application ID: ${appId} • Pacific Trust Bank Staff Review` });

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`app:accept:${appId}:${userId}`)
            .setLabel("Accept Application")
            .setStyle(ButtonStyle.Success)
            .setEmoji("🟢"),
          new ButtonBuilder()
            .setCustomId(`app:reject:${appId}:${userId}`)
            .setLabel("Reject Application")
            .setStyle(ButtonStyle.Danger)
            .setEmoji("🔴")
        );

        await reviewChannel.send({ embeds: [reviewEmbed], components: [actionRow] });
      }
    }
  } catch (err) {
    console.error("[PTB Applications] Could not forward application review embed to staff channel:", err);
  }

  return true;
}

/**
 * Handles staff review button clicks (app:accept:<appId>:<userId> or app:reject:<appId>:<userId>).
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationReviewButton(db, interaction) {
  if (!interaction.customId?.startsWith("app:")) return;

  const parts = interaction.customId.split(":");
  const action = parts[1]; // accept or reject
  const appId = parts[2];
  const applicantId = parts[3];

  if (!["accept", "reject"].includes(action)) return;

  const hasAdmin = Boolean(
    interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );

  if (!hasAdmin) {
    return interaction.reply({
      content: "⚠️ Only administrators can accept or reject staff applications.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.deferUpdate().catch(() => {});

  const newStatus = action === "accept" ? "accepted" : "rejected";

  try {
    await db.execute({
      sql: "UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [newStatus, interaction.user.id, appId],
    });
  } catch (err) {
    console.error("[PTB Applications] Failed to update application status in DB:", err);
  }

  // If accepted, try to assign registered / representative role if configured
  if (action === "accept" && interaction.guild) {
    const repRoleId = process.env.REGISTERED_ROLE_ID || process.env.REPRESENTATIVE_ROLE_ID;
    if (repRoleId) {
      try {
        const member = await interaction.guild.members.fetch(applicantId).catch(() => null);
        if (member && typeof member.roles?.add === "function") {
          await member.roles.add(repRoleId, `Staff Application #${appId} Accepted by ${interaction.user.tag}`);
        }
      } catch (roleErr) {
        console.warn("[PTB Applications] Could not assign staff/representative role to applicant:", roleErr);
      }
    }
  }

  // Notify applicant via DM
  try {
    const applicantUser = await interaction.client.users.fetch(applicantId).catch(() => null);
    if (applicantUser) {
      const dm = await applicantUser.createDM();
      const notice = action === "accept"
        ? `🎉 **Congratulations! Your Pacific Trust Bank staff application (#${appId}) has been ACCEPTED!** Welcome to the bank team.`
        : `📋 **Update on your Pacific Trust Bank staff application (#${appId})**: Thank you for applying. Unfortunately, your application was not accepted at this time.`;
      await dm.send({ content: notice }).catch(() => {});
    }
  } catch {}

  // Update staff message
  const oldEmbed = interaction.message.embeds[0];
  if (oldEmbed) {
    const updatedEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(action === "accept" ? 0x10B981 : 0xEF4444)
      .addFields({
        name: "Review Status",
        value: `**${action === "accept" ? "🟢 ACCEPTED" : "🔴 REJECTED"}** by <@${interaction.user.id}>`,
      });

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
  }
}
