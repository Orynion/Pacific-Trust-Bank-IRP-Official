import test from "node:test";
import assert from "node:assert/strict";
import { PermissionFlagsBits } from "discord.js";
import {
  PTB_COLORS,
  PTB_FOOTERS,
  DISCORD_LIMITS,
  truncate,
  resolveColor,
  isValidHttpUrl,
  safeTicketCode,
  buildPtbEmbed,
  buildInfoEmbed,
  buildSuccessEmbed,
  buildWarningEmbed,
  buildErrorEmbed,
  buildTicketPanelEmbed,
  buildTicketWelcomeEmbed,
  buildDepositAnalysisEmbed,
  buildStaffNotificationEmbed,
  buildTicketClosureSummaryEmbed,
  formatOrdinal,
  formatImageLabel,
  resolveImageLabel,
  validateCustomEmbedOptions,
  buildCustomEmbed,
  createServerEmbedCommand,
  handleServerEmbedCommand,
  parseEmbedColor,
  validateImageUrl,
  sanitizeEmbed,
  addSafeChunkedFields,
  parseDropdownOptions,
  buildDropdownComponent,
  pendingEmbedModalConfigs,
  serverEmbedCommand,
  handleServerEmbedModalSubmit,
  handleServerEmbedDropdownSelect,
} from "./ptb-embeds.js";

test("PTB color palette and footers are consistent and frozen", () => {
  assert.equal(PTB_COLORS.PRIMARY, 0x0B3D2E);
  assert.equal(PTB_COLORS.DEPOSIT, 0x0B3D2E);
  assert.equal(PTB_COLORS.WITHDRAW, 0x7C3AED);
  assert.equal(PTB_COLORS.SUCCESS, 0x16A34A);
  assert.equal(PTB_COLORS.WARNING, 0xD97706);
  assert.equal(PTB_COLORS.ERROR, 0xDC2626);
  assert.equal(PTB_COLORS.INFO, 0x2563EB);
  assert.equal(PTB_COLORS.MUTED, 0x475569);

  assert.match(PTB_FOOTERS.STANDARD, /Pacific Trust Bank/);
  assert.match(PTB_FOOTERS.STANDARD, /No real money is moved/);
  assert.doesNotMatch(PTB_FOOTERS.STANDARD, /roleplay only/i);
  assert.equal(PTB_FOOTERS.BALANCE, "Private ledger balance");
  assert.doesNotMatch(PTB_FOOTERS.BALANCE, /roleplay only/i);
  assert.match(PTB_FOOTERS.ADVISORY_RECEIPT, /Receipt analysis only/);

  assert.throws(() => {
    PTB_COLORS.PRIMARY = 0x000000;
  });
});

test("resolveColor parses numbers, hex strings, named colors, and falls back safely", () => {
  assert.equal(resolveColor(0x123456), 0x123456);
  assert.equal(resolveColor("#0B3D2E"), 0x0B3D2E);
  assert.equal(resolveColor("0x0B3D2E"), 0x0B3D2E);
  assert.equal(resolveColor("0B3D2E"), 0x0B3D2E);
  assert.equal(resolveColor("primary"), PTB_COLORS.PRIMARY);
  assert.equal(resolveColor("success"), PTB_COLORS.SUCCESS);
  assert.equal(resolveColor("warning"), PTB_COLORS.WARNING);
  assert.equal(resolveColor("error"), PTB_COLORS.ERROR);
  assert.equal(resolveColor("info"), PTB_COLORS.INFO);
  assert.equal(resolveColor("withdraw"), PTB_COLORS.WITHDRAW);

  // Fallbacks
  assert.equal(resolveColor("invalid-color", 0x111111), 0x111111);
  assert.equal(resolveColor(null, 0x222222), 0x222222);
  assert.equal(resolveColor(-5, 0x333333), 0x333333);
  assert.equal(resolveColor(0x1000000, 0x444444), 0x444444);
});

test("isValidHttpUrl accepts only valid HTTP/HTTPS URLs", () => {
  assert.equal(isValidHttpUrl("https://example.com/image.png"), true);
  assert.equal(isValidHttpUrl("http://cdn.example.org/receipt.jpg"), true);
  assert.equal(isValidHttpUrl("ftp://example.com/file"), false);
  assert.equal(isValidHttpUrl("javascript:alert(1)"), false);
  assert.equal(isValidHttpUrl("not-a-url"), false);
  assert.equal(isValidHttpUrl(""), false);
  assert.equal(isValidHttpUrl(null), false);
});

test("truncate enforces maximum string length and handles nulls", () => {
  assert.equal(truncate(null, 10), "");
  assert.equal(truncate("hello", 10), "hello");
  assert.equal(truncate("hello world", 6), "hello…");
  assert.equal(truncate("short", 2), "sh");
});

test("safeTicketCode formats deposit and withdrawal ticket codes reliably", () => {
  assert.equal(safeTicketCode({ id: 42, kind: "deposit" }), "PTB-D-42");
  assert.equal(safeTicketCode({ id: 108, kind: "withdraw" }), "PTB-W-108");
  assert.equal(safeTicketCode({ code: "PTB-D-999" }), "PTB-D-999");
  assert.equal(safeTicketCode("PTB-D-12"), "PTB-D-12");
  assert.equal(safeTicketCode(null), "PTB-TICKET");
});

test("standard embed builders (info, success, warning, error) set appropriate colors and titles", () => {
  const info = buildInfoEmbed("Notice", "Some info text");
  assert.equal(info.data.color, PTB_COLORS.INFO);
  assert.equal(info.data.title, "Notice");
  assert.equal(info.data.description, "Some info text");
  assert.equal(info.data.footer.text, PTB_FOOTERS.STANDARD);

  const success = buildSuccessEmbed({ title: "Done", description: "All set" });
  assert.equal(success.data.color, PTB_COLORS.SUCCESS);
  assert.equal(success.data.title, "Done");
  assert.equal(success.data.description, "All set");

  const warning = buildWarningEmbed("Caution", "Check balance");
  assert.equal(warning.data.color, PTB_COLORS.WARNING);
  assert.equal(warning.data.title, "Caution");

  const error = buildErrorEmbed("Failed", "Transaction failed");
  assert.equal(error.data.color, PTB_COLORS.ERROR);
  assert.equal(error.data.title, "Failed");
});

test("buildTicketPanelEmbed creates consistent public ticket panel with roleplay notices", () => {
  const panel = buildTicketPanelEmbed();
  assert.equal(panel.data.color, PTB_COLORS.PRIMARY);
  assert.match(panel.data.title, /Pacific Trust Bank/);
  assert.match(panel.data.description, /private ticket/);

  const fieldNames = panel.data.fields.map((f) => f.name);
  assert.ok(fieldNames.some((name) => name.includes("Deposit Requests")));
  assert.ok(fieldNames.some((name) => name.includes("Withdrawal Requests")));
  assert.ok(fieldNames.some((name) => name.includes("Roleplay Ledger Notice")));
});

test("buildTicketWelcomeEmbed formats deposit ticket with balance and clear instructions", () => {
  const welcome = buildTicketWelcomeEmbed({
    ticket: { id: 7, kind: "deposit", amount: 5000, requester_id: "123456" },
    type: "deposit",
    amount: 5000,
    balance: 12500,
    requester: { id: "123456" },
  });

  assert.equal(welcome.data.color, PTB_COLORS.DEPOSIT);
  assert.match(welcome.data.title, /Deposit request · PTB-D-7/);
  assert.match(welcome.data.description, /private channel/);

  const fields = welcome.data.fields;
  const requesterField = fields.find((f) => f.name === "Requester");
  const amountField = fields.find((f) => f.name === "Amount");
  const balanceField = fields.find((f) => f.name === "Balance at opening");
  const nextStepField = fields.find((f) => f.name === "What happens next");

  assert.equal(requesterField.value, "<@123456>");
  assert.equal(amountField.value, "**5,000**");
  assert.equal(balanceField.value, "12,500");
  assert.match(nextStepField.value, /Upload a clear PNG, JPEG, or WebP screenshot/);
});

test("buildTicketWelcomeEmbed formats withdrawal ticket with purple branding", () => {
  const welcome = buildTicketWelcomeEmbed({
    ticket: { id: 14, kind: "withdraw", amount: 1500, requester_id: "999888" },
    type: "withdraw",
    amount: 1500,
    requester: { id: "999888" },
  });

  assert.equal(welcome.data.color, PTB_COLORS.WITHDRAW);
  assert.match(welcome.data.title, /Withdrawal request · PTB-W-14/);
  const nextStepField = welcome.data.fields.find((f) => f.name === "What happens next");
  assert.match(nextStepField.value, /Tell ticket staff which in-game payout you are requesting/);
});

test("buildDepositAnalysisEmbed handles complete OCR result with all required fields", () => {
  const result = {
    status: "ok",
    fields: {
      amount: 500,
      currency: "EUR",
      recipient: "IRP Treasury",
      sender: "Alice_1",
      transactionId: "TX-998811",
      date: "2026-10-24",
      time: "14:30",
      paymentStatus: "completed",
      paymentMethod: "Bank Transfer",
    },
    ocr: {
      text: "Payment Successful\nAmount: 500 EUR\nRecipient: IRP Treasury\nSender: Alice_1\nTransaction ID: TX-998811",
      confidence: 94.8,
      confidenceUnit: "percent",
    },
  };

  const embed = buildDepositAnalysisEmbed(result, {
    ticket: { id: 25, amount: 500, kind: "deposit" },
    claimedAmount: 500,
    claimedPayer: "Alice_1",
    attachment: { name: "receipt.png" },
  });

  assert.equal(embed.data.color, PTB_COLORS.DEPOSIT);
  assert.match(embed.data.title, /Deposit receipt analysis · PTB-D-25/);
  assert.equal(embed.data.description, "The automated checks are advisory and still in beta testing.");
  assert.equal(embed.data.footer.text, PTB_FOOTERS.ADVISORY_RECEIPT);

  const fieldMap = Object.fromEntries(embed.data.fields.map((f) => [f.name, f.value]));

  // Verify direct fields only: Amount, Recipient, Sender, Time, Confidence
  assert.equal(embed.data.fields.length, 5);
  assert.match(fieldMap["Amount"], /500 EUR \(matches ticket amount\)/);
  assert.equal(fieldMap["Recipient"], "IRP Treasury");
  assert.equal(fieldMap["Sender"], "Alice_1");
  assert.match(fieldMap["Time"], /^<t:\d+:f>$/);
  assert.equal(fieldMap["Confidence"], "94.8%");

  // Verify excluded fields
  assert.equal(fieldMap["Transaction ID"], undefined);
  assert.equal(fieldMap["Receipt Status"], undefined);
  assert.equal(fieldMap["Payment Method"], undefined);
  assert.equal(fieldMap["Verified Payment Status"], undefined);
});

test("buildDepositAnalysisEmbed handles partial results and missing fields with 'Not detected'", () => {
  const partialResult = {
    status: "partial",
    fields: {
      amount: 1000,
      currency: null,
      recipient: null,
      sender: null,
      transactionId: null,
      date: null,
      time: null,
      paymentStatus: null,
      paymentMethod: null,
    },
    ocr: {
      text: "Paid 1000",
      confidence: null,
    },
  };

  const embed = buildDepositAnalysisEmbed(partialResult);
  assert.equal(embed.data.color, PTB_COLORS.WARNING); // Partial results trigger warning color
  assert.match(embed.data.title, /Deposit receipt analysis/);

  const fieldMap = Object.fromEntries(embed.data.fields.map((f) => [f.name, f.value]));

  assert.equal(embed.data.fields.length, 5);
  assert.equal(fieldMap["Amount"], "1,000");
  assert.equal(fieldMap["Recipient"], "Not detected");
  assert.equal(fieldMap["Sender"], "Not detected");
  assert.match(fieldMap["Time"], /^<t:\d+:f>$/);
  assert.equal(fieldMap["Confidence"], "Not detected");
  assert.equal(fieldMap["Transaction ID"], undefined);
  assert.equal(fieldMap["Receipt Status"], undefined);
});

test("buildDepositAnalysisEmbed handles OCR processing failures and error results gracefully", () => {
  const errorResult = {
    status: "error",
    error: { code: "OCR_TIMEOUT", message: "OCR processing exceeded 25 seconds limit." },
  };

  const embed = buildDepositAnalysisEmbed(errorResult, {
    ticket: { id: 33, kind: "deposit" },
    attachment: { name: "blurry.jpg" },
  });

  assert.equal(embed.data.color, PTB_COLORS.ERROR);
  assert.match(embed.data.title, /Deposit receipt analysis · PTB-D-33/);
  assert.match(embed.data.description, /OCR processing exceeded 25 seconds limit/);
  assert.match(embed.data.description, /requires manual verification by ticket staff/);

  const fieldMap = Object.fromEntries(embed.data.fields.map((f) => [f.name, f.value]));
  assert.match(fieldMap["Verification Status"], /human review required/);
  assert.match(fieldMap["Uploaded Image"], /1st image by user/);
});

test("buildDepositAnalysisEmbed respects Discord embed limits on oversized inputs", () => {
  const hugeText = "A".repeat(5000);
  const result = {
    status: "ok",
    fields: {
      amount: 50,
      recipient: hugeText,
      sender: hugeText,
      transactionId: hugeText,
      paymentMethod: hugeText,
    },
    ocr: { text: hugeText, confidence: 99 },
  };

  const embed = buildDepositAnalysisEmbed(result);
  for (const field of embed.data.fields) {
    assert.ok(field.name.length <= DISCORD_LIMITS.FIELD_NAME, `Field name too long: ${field.name}`);
    assert.ok(field.value.length <= DISCORD_LIMITS.FIELD_VALUE, `Field value too long in ${field.name}`);
  }
  assert.ok(embed.data.description.length <= DISCORD_LIMITS.DESCRIPTION);
  assert.ok(embed.data.title.length <= DISCORD_LIMITS.TITLE);
  assert.ok(embed.data.fields.length <= DISCORD_LIMITS.FIELDS);
});

test("buildStaffNotificationEmbed builds clean audit logs for all ticket actions", () => {
  const opened = buildStaffNotificationEmbed({
    action: "TICKET_OPENED",
    ticket: { id: 50, kind: "deposit", amount: 2000, requester_id: "555" },
    actorId: "555",
  });
  assert.equal(opened.data.color, PTB_COLORS.INFO);
  assert.match(opened.data.title, /Ticket opened/);

  const approved = buildStaffNotificationEmbed({
    action: "TICKET_APPROVED",
    ticket: { id: 50, kind: "deposit", amount: 2000 },
    actorId: "admin-1",
    statusBefore: "pending",
  });
  assert.equal(approved.data.color, PTB_COLORS.SUCCESS);
  assert.match(approved.data.title, /Ticket approved/);

  const rejected = buildStaffNotificationEmbed({
    action: "TICKET_REJECTED",
    ticket: { id: 50, kind: "deposit" },
    actorId: "admin-1",
    reason: "Fake screenshot",
  });
  assert.equal(rejected.data.color, PTB_COLORS.ERROR);
  assert.match(rejected.data.title, /Ticket rejected/);
});

test("buildTicketClosureSummaryEmbed records closure reasons, outcomes, and transcript info", () => {
  const summary = buildTicketClosureSummaryEmbed({
    ticket: { id: 88, kind: "deposit", amount: 1000, requester_id: "user-1", status: "completed" },
    closedBy: "staff-2",
    reason: "Funds credited and verified",
    ledgerId: 777,
    transcript: { name: "transcript-88.txt" },
  });

  assert.equal(summary.data.color, PTB_COLORS.SUCCESS);
  assert.match(summary.data.title, /Ticket closed · PTB-D-88/);

  const fieldMap = Object.fromEntries(summary.data.fields.map((f) => [f.name, f.value]));
  assert.equal(fieldMap["Ticket"], "`PTB-D-88`");
  assert.equal(fieldMap["Closed by"], "<@staff-2>");
  assert.equal(fieldMap["Final status"], "completed");
  assert.equal(fieldMap["Ledger Entry"], "#777");
  assert.equal(fieldMap["Closure reason"], "Funds credited and verified");
  assert.match(fieldMap["Transcript"], /transcript-88.txt/);
  assert.match(fieldMap["Financial outcome"], /Funds were moved/);
});

test("validateCustomEmbedOptions validates good options and catches errors", () => {
  const valid = validateCustomEmbedOptions({
    title: "Server Announcement",
    description: "Welcome to PTB!",
    color: "#0B3D2E",
    url: "https://pacifictrustbank.example",
    thumbnail: "https://pacifictrustbank.example/logo.png",
    image: "https://pacifictrustbank.example/banner.png",
    footer: "PTB Staff Team",
    fields: [
      { name: "Branch Hours", value: "24/7 Roleplay" },
    ],
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.errors.length, 0);

  // Missing title & description
  const empty = validateCustomEmbedOptions({});
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((e) => e.includes("Title is required")));
  assert.ok(empty.errors.some((e) => e.includes("Description is required")));

  // Invalid hex color
  const badColor = validateCustomEmbedOptions({
    title: "Test",
    description: "Test",
    color: "#ZZZZZZ",
  });
  assert.equal(badColor.valid, false);
  assert.ok(badColor.errors.some((e) => e.includes("Color '#ZZZZZZ' is invalid")));

  // Invalid URLs
  const badUrl = validateCustomEmbedOptions({
    title: "Test",
    description: "Test",
    url: "javascript:evil()",
    image: "ftp://files.example",
  });
  assert.equal(badUrl.valid, false);
  assert.ok(badUrl.errors.some((e) => e.includes("URL must be a valid")));
  assert.ok(badUrl.errors.some((e) => e.includes("Image must be a valid")));

  // Oversized field limits
  const tooManyFields = validateCustomEmbedOptions({
    title: "Test",
    description: "Test",
    fields: Array.from({ length: 26 }, (_, i) => ({ name: `F${i}`, value: `V${i}` })),
  });
  assert.equal(tooManyFields.valid, false);
  assert.ok(tooManyFields.errors.some((e) => e.includes("exceeds Discord maximum of 25")));
});

test("buildCustomEmbed builds a valid EmbedBuilder and honors strict mode", () => {
  const embed = buildCustomEmbed({
    title: "Admin Notice",
    description: "System maintenance at midnight",
    color: "success",
    footer: "PTB Management",
  });
  assert.equal(embed.data.title, "Admin Notice");
  assert.equal(embed.data.color, PTB_COLORS.SUCCESS);
  assert.equal(embed.data.footer.text, "PTB Management");

  // Strict mode throws on validation errors
  assert.throws(() => {
    buildCustomEmbed({ title: "" }, true);
  }, /Custom embed validation failed/);
});

test("createServerEmbedCommand configures administrator permissions and options", () => {
  const cmd = createServerEmbedCommand();
  const json = cmd.toJSON();
  assert.equal(json.name, "server-embed");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.Administrator));

  const optionNames = json.options.map((o) => o.name);
  assert.ok(optionNames.includes("title"));
  assert.ok(optionNames.includes("description"));
  assert.ok(optionNames.includes("color"));
  assert.ok(optionNames.includes("channel"));
  assert.ok(optionNames.includes("thumbnail"));
  assert.ok(optionNames.includes("image"));
  assert.ok(optionNames.includes("footer"));
});

test("handleServerEmbedCommand enforces administrator permission and sends embed", async () => {
  let replied = null;
  let sent = null;

  // Non-admin call is rejected
  const nonAdminInteraction = {
    memberPermissions: {
      has: () => false,
    },
    reply: async (msg) => { replied = msg; },
  };

  await handleServerEmbedCommand(nonAdminInteraction);
  assert.match(replied.content, /Only server administrators/);

  // Admin call succeeds
  const adminInteraction = {
    memberPermissions: {
      has: (perm) => perm === PermissionFlagsBits.Administrator,
    },
    options: {
      getString: (name) => {
        if (name === "title") return "Announcements";
        if (name === "description") return "New banking policy in effect.";
        if (name === "color") return "#0B3D2E";
        return null;
      },
      getChannel: () => null,
    },
    channel: {
      id: "general-channel",
      send: async (payload) => { sent = payload; },
    },
    reply: async (msg) => { replied = msg; },
  };

  await handleServerEmbedCommand(adminInteraction);
  assert.match(replied.content, /Embed successfully posted/);
  assert.equal(sent.embeds[0].data.title, "Announcements");
  assert.equal(sent.embeds[0].data.color, 0x0B3D2E);
});

test("formatOrdinal correctly handles 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 22nd, 23rd", () => {
  assert.equal(formatOrdinal(1), "1st");
  assert.equal(formatOrdinal(2), "2nd");
  assert.equal(formatOrdinal(3), "3rd");
  assert.equal(formatOrdinal(4), "4th");
  assert.equal(formatOrdinal(11), "11th");
  assert.equal(formatOrdinal(12), "12th");
  assert.equal(formatOrdinal(13), "13th");
  assert.equal(formatOrdinal(21), "21st");
  assert.equal(formatOrdinal(22), "22nd");
  assert.equal(formatOrdinal(23), "23rd");
  assert.equal(formatOrdinal(24), "24th");
});

test("formatImageLabel and resolveImageLabel construct user-centric image descriptions", () => {
  assert.equal(formatImageLabel({ username: "alice", index: 1 }), "1st image by alice");
  assert.equal(formatImageLabel({ username: "bob", index: 2 }), "2nd image by bob");
  assert.equal(formatImageLabel({ username: "charlie", index: 3 }), "3rd image by charlie");
  assert.equal(formatImageLabel({ username: "", index: 1 }), "1st image by user");

  assert.equal(resolveImageLabel({ imageLabel: "custom label" }), "custom label");
  assert.equal(resolveImageLabel({ username: "alice", imageIndex: 1 }), "1st image by alice");
  assert.equal(resolveImageLabel({ message: { author: { username: "dave" } }, imageIndex: 2 }), "2nd image by dave");
  assert.equal(resolveImageLabel({ claimedPayer: "Eve_1", imageIndex: 3 }), "3rd image by Eve_1");
});

test("buildDepositAnalysisEmbed error and success embeds display user image labels instead of file names", () => {
  // Error embed replaces raw file name with image label
  const errorResult = { status: "error", error: { message: "Corrupted image" } };
  const errorEmbed = buildDepositAnalysisEmbed(errorResult, {
    username: "alice",
    imageIndex: 2,
    attachment: { name: "secret_file_123.png" },
  });
  const errorField = errorEmbed.data.fields.find((f) => f.name === "Uploaded Image");
  assert.ok(errorField);
  assert.equal(errorField.value, "2nd image by alice");
  assert.ok(!JSON.stringify(errorEmbed.data).includes("secret_file_123.png"));

  // Success embed keeps direct fields and does not leak raw file name
  const successResult = {
    status: "ok",
    fields: { amount: 100, recipient: "IRP Treasury", sender: "alice" },
    ocr: { text: "100 EUR to IRP Treasury", confidence: 95 },
  };
  const successEmbed = buildDepositAnalysisEmbed(successResult, {
    username: "alice",
    imageIndex: 1,
    attachment: { name: "raw_receipt_999.png" },
    claimedAmount: 100,
  });
  assert.equal(successEmbed.data.fields.length, 5);
  assert.ok(!JSON.stringify(successEmbed.data).includes("raw_receipt_999.png"));
});

test("parseEmbedColor converts hex strings and defaults to Blurple 0x5865F2", () => {
  assert.equal(parseEmbedColor(""), 0x5865F2);
  assert.equal(parseEmbedColor(null), 0x5865F2);
  assert.equal(parseEmbedColor(undefined), 0x5865F2);
  assert.equal(parseEmbedColor("#5865F2"), 0x5865F2);
  assert.equal(parseEmbedColor("0x5865F2"), 0x5865F2);
  assert.equal(parseEmbedColor("5865F2"), 0x5865F2);
  assert.equal(parseEmbedColor("#0B3D2E"), 0x0B3D2E);

  assert.throws(() => parseEmbedColor("xyz123"), /six-digit hex value/);
  assert.throws(() => parseEmbedColor("#123"), /six-digit hex value/);
  assert.throws(() => parseEmbedColor("not-a-color"), /six-digit hex value/);
});

test("validateImageUrl validates syntax and enforces http/https protocol", () => {
  assert.equal(validateImageUrl(null), null);
  assert.equal(validateImageUrl(""), null);
  assert.equal(validateImageUrl("https://cdn.example.com/logo.png"), "https://cdn.example.com/logo.png");
  assert.equal(validateImageUrl("http://example.com/banner.jpg"), "http://example.com/banner.jpg");

  assert.throws(() => validateImageUrl("not-a-valid-url"), /valid http:\/\/ or https:\/\/ URL/);
  assert.throws(() => validateImageUrl("ftp://example.com/file.png"), /begin with http:\/\/ or https:\/\//);
  assert.throws(() => validateImageUrl("javascript:alert(1)"), /begin with http:\/\/ or https:\/\//);
});

test("sanitizeEmbed safely truncates title, description, and chunks long field values", () => {
  const overlong = {
    title: "T".repeat(300),
    description: "D".repeat(4500),
    fields: [
      { name: "LongField", value: "A".repeat(2500) },
    ],
  };

  const sanitized = sanitizeEmbed(overlong);
  assert.ok(sanitized.title.length <= 256);
  assert.ok(sanitized.title.endsWith("..."));
  assert.ok(sanitized.description.length <= 4096);
  assert.ok(sanitized.description.endsWith("..."));

  // Check field chunking
  assert.ok(sanitized.fields.length >= 3);
  assert.equal(sanitized.fields[0].name, "LongField");
  assert.match(sanitized.fields[1].name, /LongField \(Cont\. 2\)/);
  for (const f of sanitized.fields) {
    assert.ok(f.value.length <= 1024);
  }
});

test("addSafeChunkedFields breaks long line lists across multiple fields safely", () => {
  const fields = [];
  const lines = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}: ${"X".repeat(80)}`);

  addSafeChunkedFields(fields, "Transaction List", lines);

  assert.ok(fields.length > 1);
  assert.ok(fields.length <= 25);
  assert.equal(fields[0].name, "Transaction List");
  assert.match(fields[1].name, /Transaction List \(Part 2\)/);
  for (const f of fields) {
    assert.ok(f.value.length <= 1024);
  }
});

test("serverEmbedCommand and handleServerEmbedCommand support image_url, color validation, and admin execution", async () => {
  const json = serverEmbedCommand.toJSON();
  assert.equal(json.name, "server-embed");
  assert.equal(json.default_member_permissions, String(PermissionFlagsBits.Administrator));

  const optionNames = json.options.map((o) => o.name);
  assert.ok(optionNames.includes("title"));
  assert.ok(optionNames.includes("description"));
  assert.ok(optionNames.includes("color"));
  assert.ok(optionNames.includes("image_url"));
  assert.ok(optionNames.includes("footer"));

  let editReplyPayload = null;
  let replyPayload = null;
  const adminInteraction = {
    member: {
      permissions: {
        has: (perm) => perm === PermissionFlagsBits.Administrator,
      },
    },
    memberPermissions: {
      has: (perm) => perm === PermissionFlagsBits.Administrator,
    },
    deferred: true,
    replied: false,
    options: {
      getString: (name) => {
        if (name === "title") return "Server Announcement";
        if (name === "description") return "Welcome to PTB.";
        if (name === "color") return "#5865F2";
        if (name === "image_url") return "https://example.com/banner.png";
        if (name === "footer") return "PTB Staff Team";
        return null;
      },
      getChannel: () => null,
    },
    editReply: async (payload) => { editReplyPayload = payload; },
    reply: async (payload) => { replyPayload = payload; },
  };

  await handleServerEmbedCommand(adminInteraction);
  assert.ok(editReplyPayload?.embeds?.length === 1);
  const data = editReplyPayload.embeds[0].data;
  assert.equal(data.title, "Server Announcement");
  assert.equal(data.description, "Welcome to PTB.");
  assert.equal(data.color, 0x5865F2);
  assert.equal(data.image.url, "https://example.com/banner.png");
  assert.equal(data.footer.text, "PTB Staff Team");

  // Error case: invalid color
  let errorReply = null;
  const badColorInteraction = {
    member: { permissions: { has: () => true } },
    deferred: true,
    options: {
      getString: (name) => {
        if (name === "title") return "Test";
        if (name === "color") return "invalid-hex";
        return null;
      },
      getChannel: () => null,
    },
    editReply: async (payload) => { errorReply = payload; },
  };

  await handleServerEmbedCommand(badColorInteraction);
  assert.match(errorReply.content, /⚠️ Color must be a six-digit hex value/);
});

test("parseDropdownOptions parses newline, pipe, and comma formats while enforcing Discord boundaries", () => {
  assert.deepEqual(parseDropdownOptions(null), []);
  assert.deepEqual(parseDropdownOptions(""), []);
  assert.deepEqual(parseDropdownOptions("   "), []);

  // Pipe format with descriptions
  const pipeInput = "Deposit Guide | How to submit deposit receipts\nWithdrawal Rules | Terms and limits\nGeneral FAQs";
  const pipeParsed = parseDropdownOptions(pipeInput);
  assert.equal(pipeParsed.length, 3);
  assert.equal(pipeParsed[0].label, "Deposit Guide");
  assert.equal(pipeParsed[0].description, "How to submit deposit receipts");
  assert.equal(pipeParsed[0].value, "opt_1_deposit_guide");
  assert.equal(pipeParsed[1].label, "Withdrawal Rules");
  assert.equal(pipeParsed[1].description, "Terms and limits");
  assert.equal(pipeParsed[1].value, "opt_2_withdrawal_rules");
  assert.equal(pipeParsed[2].label, "General FAQs");
  assert.equal(pipeParsed[2].description, undefined);
  assert.equal(pipeParsed[2].value, "opt_3_general_faqs");

  // Comma format fallback
  const commaInput = "Option A, Option B, Option C";
  const commaParsed = parseDropdownOptions(commaInput);
  assert.equal(commaParsed.length, 3);
  assert.equal(commaParsed[0].label, "Option A");
  assert.equal(commaParsed[1].label, "Option B");
  assert.equal(commaParsed[2].label, "Option C");

  // Truncation limits: Discord allows max 100 chars for label and description, and max 25 options
  const overlongLabel = "L".repeat(150);
  const overlongDesc = "D".repeat(150);
  const truncatedParsed = parseDropdownOptions(`${overlongLabel} | ${overlongDesc}`);
  assert.equal(truncatedParsed[0].label.length, 100);
  assert.equal(truncatedParsed[0].description.length, 100);

  // Max 25 options
  const manyOptions = Array.from({ length: 30 }, (_, i) => `Option ${i + 1}`).join("\n");
  const cappedParsed = parseDropdownOptions(manyOptions);
  assert.equal(cappedParsed.length, 25);
});

test("buildDropdownComponent constructs ActionRow with StringSelectMenuBuilder", () => {
  assert.equal(buildDropdownComponent({ options: [] }), null);

  const options = [
    { label: "Option 1", value: "opt1", description: "First choice" },
    { label: "Option 2", value: "opt2" },
  ];
  const row = buildDropdownComponent({
    customId: "custom-menu-id",
    placeholder: "Choose wisely...",
    options,
  });

  assert.ok(row);
  const rowJson = row.toJSON();
  assert.equal(rowJson.type, 1); // ActionRow
  assert.equal(rowJson.components.length, 1);
  const menu = rowJson.components[0];
  assert.equal(menu.type, 3); // StringSelect
  assert.equal(menu.custom_id, "custom-menu-id");
  assert.equal(menu.placeholder, "Choose wisely...");
  assert.equal(menu.options.length, 2);
  assert.equal(menu.options[0].label, "Option 1");
  assert.equal(menu.options[0].value, "opt1");
  assert.equal(menu.options[0].description, "First choice");
});

test("handleServerEmbedCommand displays modal when function:dropdown is selected without inline options", async () => {
  let modalShown = null;
  const interaction = {
    member: {
      permissions: {
        has: () => true,
      },
    },
    memberPermissions: {
      has: () => true,
      ADMINISTRATOR: PermissionFlagsBits.Administrator,
    },
    user: { id: "admin-user-123" },
    channelId: "channel-999",
    deferred: false,
    replied: false,
    options: {
      getString: (name) => {
        if (name === "title") return "Server Rules & Roles";
        if (name === "description") return "Select your department below.";
        if (name === "function") return "dropdown";
        if (name === "dropdown_placeholder") return "Choose your department...";
        return null;
      },
      getChannel: () => null,
    },
    showModal: async (modal) => {
      modalShown = modal;
    },
    reply: async () => {},
  };

  await handleServerEmbedCommand(interaction);

  assert.ok(modalShown, "Modal should have been presented to administrator");
  const modalData = modalShown.toJSON();
  assert.equal(modalData.title, "Configure Dropdown Menu");
  assert.match(modalData.custom_id, /^server-embed-dropdown-modal:[a-z0-9]+$/);

  const token = modalData.custom_id.replace("server-embed-dropdown-modal:", "");
  assert.ok(pendingEmbedModalConfigs.has(token), "Pending embed configuration stored");
  const pending = pendingEmbedModalConfigs.get(token);
  assert.equal(pending.embedData.title, "Server Rules & Roles");
  assert.equal(pending.adminId, "admin-user-123");
});

test("handleServerEmbedCommand creates embed and dropdown directly when dropdown_options are provided", async () => {
  let replyPayload = null;
  const interaction = {
    member: {
      permissions: {
        has: () => true,
      },
    },
    memberPermissions: {
      has: () => true,
    },
    deferred: true,
    replied: false,
    options: {
      getString: (name) => {
        if (name === "title") return "Quick Navigation";
        if (name === "function") return "dropdown";
        if (name === "dropdown_placeholder") return "Go to section...";
        if (name === "dropdown_options") return "Lobby | Return to main\nBanking | Open bank guide\nSupport | Create ticket";
        return null;
      },
      getChannel: () => null,
    },
    editReply: async (payload) => {
      replyPayload = payload;
    },
  };

  await handleServerEmbedCommand(interaction);

  assert.ok(replyPayload);
  assert.equal(replyPayload.embeds.length, 1);
  assert.equal(replyPayload.embeds[0].data.title, "Quick Navigation");
  assert.equal(replyPayload.components.length, 1);
  const selectMenu = replyPayload.components[0].toJSON().components[0];
  assert.equal(selectMenu.placeholder, "Go to section...");
  assert.equal(selectMenu.options.length, 3);
  assert.equal(selectMenu.options[0].label, "Lobby");
  assert.equal(selectMenu.options[1].label, "Banking");
  assert.equal(selectMenu.options[2].label, "Support");
});

test("handleServerEmbedModalSubmit processes submitted dropdown options and posts embed", async () => {
  const token = "test-modal-token-123";
  pendingEmbedModalConfigs.set(token, {
    embedData: {
      title: "Interactive Bank Menu",
      description: "Select an inquiry topic below.",
      color: "#0B3D2E",
      imageUrl: null,
      thumbnailUrl: null,
      footerText: "PTB Information Desk",
    },
    targetChannelId: "test-channel",
    adminId: "admin-456",
    createdAt: Date.now(),
  });

  let editReplyPayload = null;
  const mockChannel = {
    id: "test-channel",
    send: async (msg) => msg,
  };

  const modalInteraction = {
    customId: `server-embed-dropdown-modal:${token}`,
    deferred: true,
    replied: false,
    channel: mockChannel,
    client: {
      channels: {
        fetch: async () => mockChannel,
      },
    },
    fields: {
      getTextInputValue: (field) => {
        if (field === "placeholder") return "Select bank service...";
        if (field === "options") return "Open Account | Register for ledger\nDeposit Help | Receipt guidance\nTax Inquiries | Business bill info";
        return "";
      },
    },
    editReply: async (payload) => {
      editReplyPayload = payload;
    },
  };

  await handleServerEmbedModalSubmit(modalInteraction);

  assert.ok(editReplyPayload);
  assert.match(editReplyPayload.content, /Embed with dropdown successfully posted/);
  assert.equal(pendingEmbedModalConfigs.has(token), false, "Pending token should be removed after posting");

  // Error case: expired or non-existent token
  let expiredReply = null;
  const expiredInteraction = {
    customId: "server-embed-dropdown-modal:expired-or-missing-token",
    deferred: true,
    editReply: async (payload) => {
      expiredReply = payload;
    },
  };
  await handleServerEmbedModalSubmit(expiredInteraction);
  assert.match(expiredReply.content, /session has expired or was not found/);
});

test("handleServerEmbedDropdownSelect responds ephemerally with selected option details", async () => {
  let selectReply = null;
  const interaction = {
    values: ["open_account"],
    component: {
      options: [
        { label: "Open Account", value: "open_account", description: "Register for ledger" },
        { label: "Deposit Help", value: "deposit_help", description: "Receipt guidance" },
      ],
    },
    deferred: false,
    replied: false,
    reply: async (payload) => {
      selectReply = payload;
    },
  };

  await handleServerEmbedDropdownSelect(interaction);

  assert.ok(selectReply);
  assert.match(selectReply.content, /You selected \*\*Open Account\*\*/);
  assert.match(selectReply.content, /> Register for ledger/);
});


