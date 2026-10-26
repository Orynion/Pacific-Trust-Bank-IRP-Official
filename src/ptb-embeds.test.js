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
  validateCustomEmbedOptions,
  buildCustomEmbed,
  createServerEmbedCommand,
  handleServerEmbedCommand,
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
  assert.match(embed.data.description, /unverified it could be unreliable and we do not hide that/);
  assert.equal(embed.data.footer.text, PTB_FOOTERS.ADVISORY_RECEIPT);

  const fieldMap = Object.fromEntries(embed.data.fields.map((f) => [f.name, f.value]));

  // Verify all 8 prompt-requested pieces of information
  assert.match(fieldMap["Amount & Currency"], /500 EUR \(matches ticket amount\)/);
  assert.equal(fieldMap["Recipient"], "IRP Treasury");
  assert.match(fieldMap["Sender / Payer"], /Alice_1/);
  assert.equal(fieldMap["Transaction ID"], "`TX-998811`");
  assert.equal(fieldMap["Date & Time"], "2026-10-24 14:30");
  assert.match(fieldMap["Receipt Status"], /completed \(read from screenshot\)/);
  assert.equal(fieldMap["Payment Method"], "Bank Transfer");
  assert.equal(fieldMap["OCR Confidence"], "94.8%");

  // Clearly distinguishes extracted OCR from verified status
  assert.equal(fieldMap["Verified Payment Status"], "🟡 Pending staff approval");

  // Context summary block verification
  assert.ok(embed.data.fields.some((f) => f.name.includes("Screenshot check for receipt.png")));
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

  assert.equal(fieldMap["Amount & Currency"], "1,000");
  assert.equal(fieldMap["Recipient"], "Not detected");
  assert.equal(fieldMap["Sender / Payer"], "Not detected");
  assert.equal(fieldMap["Transaction ID"], "Not detected");
  assert.equal(fieldMap["Date & Time"], "Not detected");
  assert.equal(fieldMap["Receipt Status"], "Not detected");
  assert.equal(fieldMap["Payment Method"], "Not detected");
  assert.equal(fieldMap["OCR Confidence"], "Not detected");
  assert.equal(fieldMap["Verified Payment Status"], "🟡 Pending staff approval");
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
  assert.match(fieldMap["Uploaded File"], /blurry.jpg/);
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

