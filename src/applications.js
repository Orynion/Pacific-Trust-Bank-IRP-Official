import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
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
    rejection_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_applications_user_status
    ON applications (user_id, status)`,
];

/**
 * Idempotent startup migration adding rejection_reason to existing applications tables.
 * @param {any} db
 * @returns {Promise<boolean>}
 */
export async function ensureApplicationRejectionReasonColumn(db) {
  try {
    await db.execute("ALTER TABLE applications ADD COLUMN rejection_reason TEXT");
  } catch (error) {
    const message = String(error?.message ?? error);
    if (!/duplicate column|already exists/i.test(message)) {
      console.error("[PTB Applications] Failed to add rejection_reason column:", message);
      return false;
    }
  }
  return true;
}

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
    prompt: "What is your exact Roblox Username and User ID (e.g., PlayerName_123 / 12345678)?",
  },
  {
    id: "discord_identity",
    prompt: "What is your Discord username and tag?",
  },
  {
    id: "experience",
    prompt: "Summarize your relevant banking, moderation, or roleplay experience in Emergency Hamburg or Roblox roleplay servers.",
  },
  {
    id: "availability",
    prompt: "What is your timezone and how many hours per week can you actively dedicate to PTB bank operations?",
  },
  {
    id: "scenario",
    prompt: "Scenario: A citizen requests a 50,000 credit withdrawal without staff approval. How do you handle this request?",
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
          .setDescription("Channel to post the application panel and forward submissions for checking")
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
      content: "# Access Denied\nOnly server administrators can manage staff applications.",
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
      args: [targetChannel.id],
    });

    const embed = new EmbedBuilder()
      .setColor(0x0B3D2E)
      .setTitle("Pacific Trust Bank | Bank Staff Applications")
      .setDescription(
        "Applications for Bank Manager and Bank Teller are now open.\n\n" +
        "We are looking for dedicated, professional roleplayers to manage citizen accounts, process deposits and withdrawals, and uphold Pacific Trust Bank ledger policies.\n\n" +
        "Select a role below to start your private application questionnaire in Direct Messages."
      )
      .addFields(
        { name: "Positions Available", value: "• Bank Manager: Oversees ledger audits, staff operations, and approvals.\n• Bank Teller: Handles citizen deposits, withdrawals, and customer service." },
        { name: "Requirements", value: "• Active Emergency Hamburg player\n• Professional conduct and reliable availability" }
      )
      .setFooter({ text: "Pacific Trust Bank • Official Staff Application" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("app:apply:manager")
        .setLabel("Apply for Bank Manager")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("app:apply:teller")
        .setLabel("Apply for Bank Teller")
        .setStyle(ButtonStyle.Success)
    );

    try {
      await targetChannel.send({ embeds: [embed], components: [row] });
    } catch (err) {
      console.error("[PTB Applications] Could not post public application panel:", err);
    }
  }

  const statusText = action === "open" ? "OPENED" : "CLOSED";
  return interaction.reply({
    content: `# Applications Updated\nStaff applications are now **${statusText}**.\nReview channel: <#${targetChannel.id}>`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Handles clicks on application buttons (app:apply:manager or app:apply:teller).
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationApplyButton(db, interaction) {
  if (!interaction.customId?.startsWith("app:apply:")) return;

  const roleType = interaction.customId === "app:apply:manager" ? "Bank Manager" : "Bank Teller";

  await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});

  const isOpen = await areApplicationsOpen(db);
  if (!isOpen) {
    return interaction.editReply({
      content: "# Applications Closed\nBank staff applications are currently closed. Please check back later.",
    });
  }

  const userId = interaction.user.id;

  try {
    const existing = await db.execute({
      sql: "SELECT id FROM applications WHERE user_id = ? AND status = 'pending' LIMIT 1",
      args: [userId],
    });
    if (existing.rows?.length > 0) {
      return interaction.editReply({
        content: "# Application Pending\nYou already have a pending staff application under review. Please wait for staff to review your submission.",
      });
    }
  } catch {}

  if (activeApplicationSessions.has(userId)) {
    return interaction.editReply({
      content: "# Questionnaire Active\nYou already have an active application questionnaire session open in your Direct Messages. Check your DMs to complete it (or type `cancel` to abort).",
    });
  }

  try {
    const dmChannel = await interaction.user.createDM();
    const firstQ = APPLICATION_QUESTIONS[0];

    activeApplicationSessions.set(userId, {
      roleDesired: roleType,
      currentIndex: 0,
      answers: {},
      createdAt: Date.now(),
    });

    const introMsg = [
      "# Pacific Trust Bank | Staff Application",
      `Applying for position: **${roleType}**`,
      "Please answer the following questions honestly. You can type `cancel` at any time to abort this questionnaire.",
      "",
      `**1. ${firstQ.prompt}**`,
    ].join("\n");

    await dmChannel.send({ content: introMsg });

    return interaction.editReply({
      content: `# Questionnaire Started\nI have sent you a Direct Message with the first application question for **${roleType}**! Please check your DMs.`,
    });
  } catch (err) {
    console.error("[PTB Applications] Could not open DM with user:", err);
    return interaction.editReply({
      content: "Direct Messages Closed: I could not send you a Direct Message. Please enable direct messages from server members and click the apply button again.",
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
    await message.reply("Application Cancelled. Your questionnaire session has been discarded.").catch(() => {});
    return true;
  }

  const currentQ = APPLICATION_QUESTIONS[session.currentIndex];
  session.answers[currentQ.id] = content;
  session.currentIndex++;

  if (session.currentIndex < APPLICATION_QUESTIONS.length) {
    const nextQ = APPLICATION_QUESTIONS[session.currentIndex];
    const qNum = session.currentIndex + 1;
    await message.reply(`**${qNum}. ${nextQ.prompt}**`).catch(() => {});
    return true;
  }

  // Questionnaire complete! Persist to DB and notify staff
  activeApplicationSessions.delete(userId);

  // Attach role_desired to answers
  session.answers.role_desired = session.roleDesired;

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
    await message.reply("There was an error saving your application to the database. Please try again later.").catch(() => {});
    return true;
  }

  await message.reply(
    "**Application Submitted Successfully!**\n" +
    "Thank you for applying to join the Pacific Trust Bank staff team. Your submission has been forwarded to bank administrators for review."
  ).catch(() => {});

  // Forward review embed to Staff Review Channel and ping everyone who can see the channel
  try {
    const reviewChannelId = await getApplicationReviewChannelId(db);
    if (reviewChannelId && message.client?.channels) {
      const reviewChannel = await message.client.channels.fetch(reviewChannelId).catch(() => null);
      if (reviewChannel && typeof reviewChannel.send === "function") {
        const answers = session.answers;
        const reviewEmbed = new EmbedBuilder()
          .setColor(0x2563EB)
          .setTitle(`New Staff Application #${appId} (${session.roleDesired})`)
          .setDescription(`Applicant: <@${userId}> (\`${message.author.tag || message.author.username}\`)`)
          .addFields(
            { name: "Position Desired", value: session.roleDesired },
            { name: "Roblox Identity", value: answers.roblox_identity || "N/A" },
            { name: "Discord Identity", value: answers.discord_identity || "N/A" },
            { name: "Experience", value: answers.experience || "N/A" },
            { name: "Availability", value: answers.availability || "N/A" },
            { name: "Scenario Response", value: answers.scenario || "N/A" },
          )
          .setTimestamp()
          .setFooter({ text: `Application ID: ${appId} • Pacific Trust Bank Staff Review` });

        const actionRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`app:accept:${appId}:${userId}`)
            .setLabel("Accept Application")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(`app:reject:${appId}:${userId}`)
            .setLabel("Reject Application")
            .setStyle(ButtonStyle.Danger)
        );

        await reviewChannel.send({
          content: "@everyone",
          embeds: [reviewEmbed],
          components: [actionRow],
        });
      }
    }
  } catch (err) {
    console.error("[PTB Applications] Could not forward application review embed to staff channel:", err);
  }

  return true;
}

function isApplicationReviewer(interaction) {
  return Boolean(
    interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

/**
 * Finalizes an application review decision (accept or reject) and notifies the applicant.
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction | import("discord.js").ModalSubmitInteraction} interaction
 * @param {{ action: "accept" | "reject", appId: string, applicantId: string, reason?: string }} params
 * @returns {Promise<void>}
 */
async function finalizeApplicationReview(db, interaction, { action, appId, applicantId, reason = "" }) {
  const cleanReason = String(reason ?? "").trim().slice(0, 500);
  const newStatus = action === "accept" ? "accepted" : "rejected";
  const storedReason = action === "reject" && cleanReason ? cleanReason : null;

  const isModal = typeof interaction.isModalSubmit === "function" && interaction.isModalSubmit();
  const hasMessage = Boolean(interaction.message);

  if (!isModal || hasMessage) {
    if (typeof interaction.deferUpdate === "function" && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
  } else if (typeof interaction.deferReply === "function" && !interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

  let updatedRows = 1;
  try {
    const updateRes = await db.execute({
      sql: "UPDATE applications SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, rejection_reason = ? WHERE id = ? AND status = 'pending'",
      args: [newStatus, interaction.user.id, storedReason, appId],
    });
    if (updateRes && updateRes.rowsAffected !== undefined) {
      updatedRows = Number(updateRes.rowsAffected);
    }
  } catch (err) {
    console.error("[PTB Applications] Failed to update application status in DB:", err);
  }

  if (updatedRows === 0) {
    const existing = await db.execute({
      sql: "SELECT status, reviewed_by FROM applications WHERE id = ? LIMIT 1",
      args: [appId],
    }).catch(() => null);
    const current = existing?.rows?.[0];
    const alreadyMsg = current
      ? `Application #${appId} has already been **${String(current.status).toUpperCase()}**${current.reviewed_by ? ` by <@${current.reviewed_by}>` : ""}.`
      : `Application #${appId} was not found or is no longer pending.`;

    if (interaction.deferred && typeof interaction.followUp === "function" && (!isModal || hasMessage)) {
      await interaction.followUp({ content: alreadyMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    } else if (interaction.deferred && typeof interaction.editReply === "function") {
      await interaction.editReply({ content: alreadyMsg }).catch(() => {});
    } else if (typeof interaction.reply === "function") {
      await interaction.reply({ content: alreadyMsg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

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

  try {
    const applicantUser = await interaction.client.users.fetch(applicantId).catch(() => null);
    if (applicantUser) {
      const dm = await applicantUser.createDM();
      let notice;
      if (action === "accept") {
        notice = `**Congratulations! Your Pacific Trust Bank staff application (#${appId}) has been ACCEPTED.** Welcome to the bank team.`;
      } else if (cleanReason) {
        notice = `**Update on your Pacific Trust Bank staff application (#${appId})**: Thank you for applying. Unfortunately, your application was not accepted at this time.\n**Reason:** ${cleanReason}`;
      } else {
        notice = `**Update on your Pacific Trust Bank staff application (#${appId})**: Thank you for applying. Unfortunately, your application was not accepted at this time.`;
      }
      await dm.send({ content: notice }).catch(() => {});
    }
  } catch {}

  const oldEmbed = interaction.message?.embeds?.[0];
  if (oldEmbed) {
    const updatedEmbed = EmbedBuilder.from(oldEmbed)
      .setColor(action === "accept" ? 0x10B981 : 0xEF4444)
      .addFields({
        name: "Review Status",
        value: `**${action === "accept" ? "ACCEPTED" : "REJECTED"}** by <@${interaction.user.id}>`,
      });
    if (action === "reject" && cleanReason) {
      updatedEmbed.addFields({
        name: "Rejection Reason",
        value: cleanReason,
      });
    }

    await interaction.message.edit({ embeds: [updatedEmbed], components: [] }).catch(() => {});
  } else if (isModal) {
    const confirmation = `Application #${appId} has been **REJECTED**${cleanReason ? `.\n**Reason:** ${cleanReason}` : "."}`;
    if (interaction.deferred && typeof interaction.editReply === "function") {
      await interaction.editReply({ content: confirmation }).catch(() => {});
    } else if (typeof interaction.reply === "function") {
      await interaction.reply({ content: confirmation, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
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

  if (!isApplicationReviewer(interaction)) {
    return interaction.reply({
      content: "Only administrators can accept or reject staff applications.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (action === "reject" && typeof interaction.showModal === "function") {
    const existing = await db.execute({
      sql: "SELECT status, reviewed_by FROM applications WHERE id = ? LIMIT 1",
      args: [appId],
    }).catch(() => null);
    const current = existing?.rows?.[0];
    if (current && current.status !== "pending") {
      return interaction.reply({
        content: `Application #${appId} has already been **${String(current.status).toUpperCase()}**${current.reviewed_by ? ` by <@${current.reviewed_by}>` : ""}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`app:reject-modal:${appId}:${applicantId}`)
      .setTitle(`Reject Application #${appId}`.slice(0, 45));
    modal.addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("reason")
          .setLabel("Rejection reason (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500)
          .setPlaceholder("Optional: share feedback or why the application was rejected"),
      ),
    );
    return interaction.showModal(modal);
  }

  return finalizeApplicationReview(db, interaction, { action, appId, applicantId });
}

/**
 * Handles modal submission for rejecting a staff application with an optional reason.
 * @param {any} db
 * @param {import("discord.js").ModalSubmitInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationRejectModal(db, interaction) {
  if (!interaction.customId?.startsWith("app:reject-modal:")) return;

  if (!isApplicationReviewer(interaction)) {
    return interaction.reply({
      content: "Only administrators can accept or reject staff applications.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const parts = interaction.customId.split(":");
  const appId = parts[2];
  const applicantId = parts[3];

  let reason = "";
  try {
    reason = String(interaction.fields?.getTextInputValue("reason") ?? "").trim().slice(0, 500);
  } catch {
    reason = "";
  }

  return finalizeApplicationReview(db, interaction, {
    action: "reject",
    appId,
    applicantId,
    reason,
  });
}
