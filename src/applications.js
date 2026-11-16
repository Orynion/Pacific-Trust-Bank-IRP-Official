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
export const activeSessions = activeApplicationSessions;

/**
 * Maximum idle/total lifetime of a DM questionnaire session (30 minutes).
 */
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Questionnaire questions for Bank Manager / Bank Teller / Representative role applications.
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
export const DEFAULT_APPLICATION_QUESTIONS = APPLICATION_QUESTIONS;

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
 * Resolve the staff review channel ID using DB settings and environment fallbacks.
 * @param {any} db
 * @returns {Promise<string|null>}
 */
export async function resolveReviewChannelId(db) {
  const fromDb = await getApplicationReviewChannelId(db);
  return (
    fromDb ||
    process.env.APPLICATIONS_REVIEW_CHANNEL_ID ||
    process.env.DEFAULT_APPLICATIONS_REVIEW_CHANNEL_ID ||
    process.env.APPLICATIONS_CHANNEL_ID ||
    process.env.MOD_LOG_CHANNEL_ID ||
    process.env.TICKET_LOG_CHANNEL_ID ||
    null
  );
}

/**
 * Handles /application status:open / close command.
 * @param {any} db
 * @param {import("discord.js").ChatInputCommandInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationCommand(db, interaction) {
  if (!isApplicationReviewer(interaction)) {
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
 * Handles clicks on application buttons (app:apply:manager, app:apply:teller, or app:apply_rep).
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationApplyButton(db, interaction) {
  if (!interaction.customId?.startsWith("app:apply")) return;

  let roleType = "Bank Teller";
  if (interaction.customId === "app:apply:manager") {
    roleType = "Bank Manager";
  } else if (interaction.customId === "app:apply_rep") {
    roleType = "Bank Representative";
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => {});
  }

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

  const existingSession = activeApplicationSessions.get(userId);
  if (existingSession) {
    const startedAt = existingSession.startedAt ?? existingSession.createdAt ?? 0;
    if (Date.now() - startedAt > SESSION_TIMEOUT_MS) {
      activeApplicationSessions.delete(userId);
    } else {
      return interaction.editReply({
        content: "# Questionnaire Active\nYou already have an active application questionnaire session open in your Direct Messages. Check your DMs to complete it (or type `cancel` to abort).",
      });
    }
  }

  try {
    const dmChannel = await interaction.user.createDM();
    const firstQ = APPLICATION_QUESTIONS[0];
    const now = Date.now();

    activeApplicationSessions.set(userId, {
      roleDesired: roleType,
      step: 0,
      currentIndex: 0,
      answers: {},
      startedAt: now,
      createdAt: now,
    });

    const introMsg = [
      "# Pacific Trust Bank | Staff Application",
      `Applying for position: **${roleType}**`,
      `Please answer the following ${APPLICATION_QUESTIONS.length} questions honestly (session expires after 30 minutes). You can type \`cancel\` at any time to abort this questionnaire.`,
      "",
      `**1/${APPLICATION_QUESTIONS.length}. ${firstQ.prompt}**`,
    ].join("\n");

    await dmChannel.send({ content: introMsg });

    return interaction.editReply({
      content: `# Questionnaire Started\nI have sent you a Direct Message with Question 1 of ${APPLICATION_QUESTIONS.length} for **${roleType}**! Please check your DMs.`,
    });
  } catch (err) {
    console.error("[PTB Applications] Could not open DM with user:", err);
    return interaction.editReply({
      content: "Direct Messages Closed: I could not send you a Direct Message. Please enable direct messages from server members and click the apply button again.",
    });
  }
}
export const handleApplyButton = handleApplicationApplyButton;

/**
 * Post a staff review embed with Accept / Reject buttons to the configured review channel.
 * @param {{ db: any, client: any, appId: number|string, user: any, roleDesired: string, answers: Record<string, string> }} params
 * @returns {Promise<boolean>}
 */
export async function notifyStaffReview({ db, client, appId, user, roleDesired, answers }) {
  try {
    const reviewChannelId = await resolveReviewChannelId(db);
    if (!reviewChannelId || !client?.channels?.fetch) return false;

    const reviewChannel = await client.channels.fetch(reviewChannelId).catch(() => null);
    if (!reviewChannel || typeof reviewChannel.send !== "function") return false;

    const userId = user?.id || "unknown";
    const userTag = user?.tag || user?.username || "unknown";

    const reviewEmbed = new EmbedBuilder()
      .setColor(0x2563EB)
      .setTitle(`New Staff Application #${appId} (${roleDesired})`)
      .setDescription(`Applicant: <@${userId}> (\`${userTag}\`)`)
      .addFields(
        { name: "Position Desired", value: String(roleDesired || "Bank Staff").slice(0, 1024) },
        { name: "1. Roblox Identity", value: String(answers?.roblox_identity || "N/A").slice(0, 1024) },
        { name: "2. Discord Identity", value: String(answers?.discord_identity || "N/A").slice(0, 1024) },
        { name: "3. Experience", value: String(answers?.experience || "N/A").slice(0, 1024) },
        { name: "4. Availability", value: String(answers?.availability || "N/A").slice(0, 1024) },
        { name: "5. Scenario Response", value: String(answers?.scenario || "N/A").slice(0, 1024) },
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
    return true;
  } catch (err) {
    console.error("[PTB Applications] Could not forward application review embed to staff channel:", err);
    return false;
  }
}

/**
 * Handles incoming DM messages from users completing active application sessions.
 * @param {any} db
 * @param {import("discord.js").Message} message
 * @param {any} [client]
 * @returns {Promise<boolean>} returns true if the message was handled as part of an application session
 */
export async function handleApplicationMessageCreate(db, message, client = null) {
  if (!message || message.author?.bot || message.guild) return false;

  const userId = message.author.id;
  const session = activeApplicationSessions.get(userId);
  if (!session) return false;

  const startedAt = session.startedAt ?? session.createdAt ?? 0;
  if (Date.now() - startedAt > SESSION_TIMEOUT_MS) {
    activeApplicationSessions.delete(userId);
    await message.reply(
      "Application Session Expired: Your questionnaire timed out after 30 minutes of inactivity. Please click the Apply button in the server again to restart."
    ).catch(() => {});
    return true;
  }

  const content = message.content?.trim() || "";
  if (/^cancel$/i.test(content)) {
    activeApplicationSessions.delete(userId);
    await message.reply("Application Cancelled. Your questionnaire session has been discarded.").catch(() => {});
    return true;
  }

  if (!content) {
    const qIndex = session.step ?? session.currentIndex ?? 0;
    const currentQ = APPLICATION_QUESTIONS[qIndex];
    await message.reply(
      `Please enter a text answer for **${qIndex + 1}/${APPLICATION_QUESTIONS.length}. ${currentQ.prompt}** (or type \`cancel\` to abort).`
    ).catch(() => {});
    return true;
  }

  const qIndex = session.step ?? session.currentIndex ?? 0;
  const currentQ = APPLICATION_QUESTIONS[qIndex];
  session.answers[currentQ.id] = content.slice(0, 1000);
  session.step = qIndex + 1;
  session.currentIndex = session.step;

  if (session.step < APPLICATION_QUESTIONS.length) {
    const nextQ = APPLICATION_QUESTIONS[session.step];
    const qNum = session.step + 1;
    await message.reply(`**${qNum}/${APPLICATION_QUESTIONS.length}. ${nextQ.prompt}**`).catch(() => {});
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
    if (appId === undefined || appId === null || Number.isNaN(appId)) {
      const idRes = await db.execute({ sql: "SELECT last_insert_rowid() AS id", args: [] });
      appId = Number(idRes.rows[0].id);
    }
  } catch (dbErr) {
    console.error("[PTB Applications] Failed to save application to database:", dbErr);
    await message.reply("There was an error saving your application to the database. Please try again later.").catch(() => {});
    return true;
  }

  const confirmationEmbed = new EmbedBuilder()
    .setColor(0x0B3D2E)
    .setTitle("Pacific Trust Bank | Application Submitted")
    .setDescription(
      "Thank you for applying to join the Pacific Trust Bank staff team! Your responses have been forwarded to bank administrators for review."
    )
    .addFields(
      { name: "Application ID", value: `#${appId}`, inline: true },
      { name: "Position Desired", value: session.roleDesired, inline: true },
      { name: "Status", value: "Pending Review", inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Pacific Trust Bank • You will receive a DM once reviewed." });

  await message.reply({
    content: "**Application Submitted Successfully!**",
    embeds: [confirmationEmbed],
  }).catch(() => {});

  await notifyStaffReview({
    db,
    client: client || message.client,
    appId,
    user: message.author,
    roleDesired: session.roleDesired,
    answers: session.answers,
  });

  return true;
}

/**
 * Spec-aligned wrapper for DM message routing: handleDirectMessage(message, client, db).
 * @param {import("discord.js").Message} message
 * @param {any} client
 * @param {any} db
 * @returns {Promise<boolean>}
 */
export function handleDirectMessage(message, client, db) {
  return handleApplicationMessageCreate(db, message, client);
}

function isApplicationReviewer(interaction) {
  if (
    interaction.member?.permissions?.has(PermissionFlagsBits.Administrator) ||
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    return true;
  }
  const cache = interaction.member?.roles?.cache;
  if (!cache || typeof cache.has !== "function") return false;

  const allowedRoleIds = [
    process.env.OWNER_ROLE_ID,
    ...String(process.env.APPLICATIONS_REVIEWER_ROLE_IDS ?? "").split(","),
  ]
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);

  return allowedRoleIds.some((roleId) => cache.has(roleId));
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
    const repRoleId =
      process.env.REPRESENTATIVE_ROLE_ID ||
      process.env.REGISTERED_ROLE_ID;
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
      const decisionEmbed = new EmbedBuilder()
        .setTitle(`Pacific Trust Bank | Application #${appId}`)
        .setTimestamp()
        .setFooter({ text: "Pacific Trust Bank • Staff Applications" });

      if (action === "accept") {
        notice = `**Congratulations! Your Pacific Trust Bank staff application (#${appId}) has been ACCEPTED.** Welcome to the bank team.`;
        decisionEmbed
          .setColor(0x10B981)
          .setDescription("Your application has been **ACCEPTED**. Welcome to the Pacific Trust Bank team!");
      } else if (cleanReason) {
        notice = `**Update on your Pacific Trust Bank staff application (#${appId})**: Thank you for applying. Unfortunately, your application was not accepted at this time.\n**Reason:** ${cleanReason}`;
        decisionEmbed
          .setColor(0xEF4444)
          .setDescription("Thank you for applying. Unfortunately, your application was not accepted at this time.")
          .addFields({ name: "Reason", value: cleanReason });
      } else {
        notice = `**Update on your Pacific Trust Bank staff application (#${appId})**: Thank you for applying. Unfortunately, your application was not accepted at this time.`;
        decisionEmbed
          .setColor(0xEF4444)
          .setDescription("Thank you for applying. Unfortunately, your application was not accepted at this time.");
      }
      await dm.send({ content: notice, embeds: [decisionEmbed] }).catch(() => {});
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
 * Handles staff review button clicks (app:accept:<appId>:<userId>, app:reject:<appId>:<userId>,
 * or app:review:accept:<appId>:<userId>, app:review:reject:<appId>:<userId>).
 * @param {any} db
 * @param {import("discord.js").ButtonInteraction} interaction
 * @returns {Promise<void>}
 */
export async function handleApplicationReviewButton(db, interaction) {
  if (!interaction.customId?.startsWith("app:")) return;

  const parts = interaction.customId.split(":");
  const offset = parts[1] === "review" ? 1 : 0;
  const action = parts[1 + offset]; // accept or reject
  const appId = parts[2 + offset];
  const applicantId = parts[3 + offset];

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
export const handleReviewButton = handleApplicationReviewButton;

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
