import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { analyzeReceipt, extractDepositConfirmation, OCR_STATUS } from "./deposit-detection.js";

// Helper: build synthetic Emergency Hamburg SVG screenshots
function makeEhScreenshotSvg({
  width = 1920,
  height = 1080,
  time = "21:52",
  balance = "61.04k €",
  amount = "8,000 €",
  recipient = "Chickenwings",
  bgColor = "#2d3748",
  modalColor = "#206694",
  layout = "full", // "full", "ultrawide", "cropped_phone", "cropped_card"
} = {}) {
  if (layout === "cropped_card") {
    return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="${modalColor}"/>
      <text x="${width / 2}" y="${height * 0.4}" font-family="Arial, sans-serif" font-size="36" font-weight="bold" text-anchor="middle" fill="#ffffff">Successfully sent</text>
      <text x="${width / 2}" y="${height * 0.65}" font-family="Arial, sans-serif" font-size="38" font-weight="bold" text-anchor="middle" fill="#ffffff">${amount} to ${recipient}</text>
    </svg>`;
  }

  if (layout === "cropped_phone") {
    return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${width}" height="${height}" fill="#0f172a"/>
      <rect x="25" y="60" width="${width - 50}" height="${height - 120}" rx="16" fill="#1e293b"/>
      <rect x="45" y="${height * 0.3}" width="${width - 90}" height="240" rx="16" fill="${modalColor}"/>
      <text x="${width / 2}" y="${height * 0.3 + 80}" font-family="Arial, sans-serif" font-size="28" font-weight="bold" text-anchor="middle" fill="#ffffff">Successfully sent</text>
      <text x="${width / 2}" y="${height * 0.3 + 150}" font-family="Arial, sans-serif" font-size="30" font-weight="bold" text-anchor="middle" fill="#ffffff">${amount} to ${recipient}</text>
    </svg>`;
  }

  // Full in-game screen (1080p or ultrawide 2560x1080):
  // Phone docked at lower-left, HUD clock and balance at top.
  const phoneX = 80;
  const phoneY = Math.round(height * 0.45);
  const phoneW = 380;
  const phoneH = Math.round(height * 0.52);
  const modalX = phoneX + 25;
  const modalY = phoneY + 120;
  const modalW = phoneW - 50;
  const modalH = 220;

  return `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <!-- 3D Environment -->
    <rect width="${width}" height="${height}" fill="${bgColor}"/>
    <rect x="0" y="${height * 0.6}" width="${width}" height="${height * 0.4}" fill="#1a202c"/>

    <!-- Top HUD: Clock and Balance (Must NEVER be parsed as the transfer amount) -->
    <rect x="20" y="20" width="160" height="50" rx="8" fill="#111827"/>
    <text x="40" y="55" font-family="Arial, sans-serif" font-size="28" font-weight="bold" fill="#ffffff">${time}</text>

    <rect x="${width - 240}" y="20" width="220" height="50" rx="8" fill="#111827"/>
    <text x="${width - 220}" y="55" font-family="Arial, sans-serif" font-size="26" font-weight="bold" fill="#10b981">${balance}</text>

    <!-- In-Game Smartphone -->
    <rect x="${phoneX}" y="${phoneY}" width="${phoneW}" height="${phoneH}" rx="24" fill="#0f172a"/>
    <rect x="${phoneX + 15}" y="${phoneY + 40}" width="${phoneW - 30}" height="${phoneH - 60}" rx="12" fill="#1e293b"/>

    <!-- Blue Payment Modal -->
    <rect x="${modalX}" y="${modalY}" width="${modalW}" height="${modalH}" rx="16" fill="${modalColor}"/>
    <text x="${modalX + modalW / 2}" y="${modalY + 75}" font-family="Arial, sans-serif" font-size="26" font-weight="bold" text-anchor="middle" fill="#ffffff">Successfully sent</text>
    <text x="${modalX + modalW / 2}" y="${modalY + 135}" font-family="Arial, sans-serif" font-size="28" font-weight="bold" text-anchor="middle" fill="#ffffff">${amount} to ${recipient}</text>
  </svg>`;
}

test("deterministic parser: extracts amount and recipient across all Emergency Hamburg formats", () => {
  const cases = [
    {
      input: "Successfully sent 8,000 € to Chickenwings",
      expectedAmount: 8000,
      expectedRecipient: "Chickenwings",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent 8,000 € to Chickenwings.",
      expectedAmount: 8000,
      expectedRecipient: "Chickenwings",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent\n8,000 € to L4RRY",
      expectedAmount: 8000,
      expectedRecipient: "L4RRY",
      expectedStatus: "ok",
    },
    {
      input: "sent 8,000 € to ale",
      expectedAmount: 8000,
      expectedRecipient: "ale",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent €8,000 to Chickenwings",
      expectedAmount: 8000,
      expectedRecipient: "Chickenwings",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent 8.000 € to Chickenwings",
      expectedAmount: 8000,
      expectedRecipient: "Chickenwings",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent 8 000 EUR to Chickenwings",
      expectedAmount: 8000,
      expectedRecipient: "Chickenwings",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent 8,000 C to Chickenwings",
      expectedAmount: 8000,
      expectedRecipient: "Chickenwings",
      expectedStatus: "ok",
    },
    {
      input: "Successfully sent 15,500 € to Officer_Max",
      expectedAmount: 15500,
      expectedRecipient: "Officer_Max",
      expectedStatus: "ok",
    },
    {
      input: "Payment successful\nAmount paid: 500 USD\nRecipient: IRP Treasury",
      expectedAmount: 500,
      expectedRecipient: "IRP Treasury",
      expectedStatus: "ok",
    },
    {
      input: "Payer Alice_1 paid Amount: 3,000 to IRP Treasury",
      expectedAmount: 3000,
      expectedRecipient: "IRP Treasury",
      expectedStatus: "ok",
    },
    {
      input: "Transferred 1,200 € to Bob_99",
      expectedAmount: 1200,
      expectedRecipient: "Bob_99",
      expectedStatus: "ok",
    },
  ];

  for (const { input, expectedAmount, expectedRecipient, expectedStatus } of cases) {
    const res = extractDepositConfirmation(input);
    assert.equal(res.status, expectedStatus, `Failed status on: ${input}`);
    assert.equal(res.fields.amount, expectedAmount, `Failed amount on: ${input}`);
    assert.equal(res.fields.recipient, expectedRecipient, `Failed recipient on: ${input}`);
    assert.equal(res.diagnosticsStatus, OCR_STATUS.OK);
  }
});

test("deterministic parser: rejects HUD clocks, account balances, and unrelated numbers", () => {
  // Input containing HUD clock and balance alongside confirmation
  const contaminated = "21:52 61.04k € Minimap Successfully sent 8,000 € to Chickenwings Speed: 65 km/h";
  const res1 = extractDepositConfirmation(contaminated);
  assert.equal(res1.status, "ok");
  assert.equal(res1.fields.amount, 8000, "Must not pick up 21, 52, or 61040");
  assert.equal(res1.fields.recipient, "Chickenwings");

  // Input containing ONLY HUD text and no payment action
  const onlyHud = "21:52 61.04k € Minimap Speed: 65 km/h Health: 100/100";
  const res2 = extractDepositConfirmation(onlyHud);
  assert.equal(res2.status, "unreadable");
  assert.equal(res2.fields.amount, null);
  assert.equal(res2.fields.recipient, null);
  assert.equal(res2.diagnosticsStatus, OCR_STATUS.PAYMENT_CONFIRMATION_NOT_FOUND);
});

test("diagnostic status: returns explicit statuses on partial or missing components", () => {
  // Empty OCR text
  const empty = extractDepositConfirmation("");
  assert.equal(empty.status, "unreadable");
  assert.equal(empty.diagnosticsStatus, OCR_STATUS.OCR_FAILED);

  // Missing recipient
  const noRecipient = extractDepositConfirmation("Successfully sent 8,000 €");
  assert.equal(noRecipient.status, "partial");
  assert.equal(noRecipient.fields.amount, 8000);
  assert.equal(noRecipient.fields.recipient, null);
  assert.equal(noRecipient.diagnosticsStatus, OCR_STATUS.RECIPIENT_NOT_FOUND);

  // Missing amount
  const noAmount = extractDepositConfirmation("Successfully sent to Chickenwings");
  assert.equal(noAmount.status, "partial");
  assert.equal(noAmount.fields.amount, null);
  assert.equal(noAmount.fields.recipient, "Chickenwings");
  assert.equal(noAmount.diagnosticsStatus, OCR_STATUS.AMOUNT_NOT_FOUND);
});

test("analyzeReceipt: input validation returns explicit error codes", async () => {
  const invalid = await analyzeReceipt("not-a-buffer");
  assert.equal(invalid.status, "error");
  assert.equal(invalid.diagnostics.status, OCR_STATUS.INVALID_INPUT);

  const empty = await analyzeReceipt(Buffer.alloc(0));
  assert.equal(empty.status, "error");
  assert.equal(empty.diagnostics.status, OCR_STATUS.EMPTY_IMAGE);

  const fakeTooLarge = Buffer.alloc(8 * 1024 * 1024 + 1);
  const tooLarge = await analyzeReceipt(fakeTooLarge);
  assert.equal(tooLarge.status, "error");
  assert.equal(tooLarge.diagnostics.status, OCR_STATUS.IMAGE_TOO_LARGE);
});

test("analyzeReceipt: 1080p full game screenshot OCR extracts 8000 € to Chickenwings without HUD interference", async () => {
  const svg = makeEhScreenshotSvg({
    width: 1920,
    height: 1080,
    time: "21:52",
    balance: "61.04k €",
    amount: "8,000 €",
    recipient: "Chickenwings",
    layout: "full",
  });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const res = await analyzeReceipt(buf);

  assert.equal(res.status, "ok");
  assert.equal(res.fields.amount, 8000);
  assert.equal(res.fields.recipient, "Chickenwings");
  assert.equal(res.diagnostics.status, OCR_STATUS.OK);
  assert.ok(res.ocr.text.includes("Successfully sent"));
});

test("analyzeReceipt: ultrawide 2560x1080 screenshot OCR extracts 8000 €", async () => {
  const svg = makeEhScreenshotSvg({
    width: 2560,
    height: 1080,
    time: "18:40",
    balance: "145.20k €",
    amount: "8,000 €",
    recipient: "Chickenwings",
    layout: "ultrawide",
  });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const res = await analyzeReceipt(buf);

  assert.equal(res.status, "ok");
  assert.equal(res.fields.amount, 8000);
  assert.equal(res.diagnostics.status, OCR_STATUS.OK);
});

test("analyzeReceipt: cropped phone screenshot OCR extracts 8000 € to ale", async () => {
  const svg = makeEhScreenshotSvg({
    width: 450,
    height: 800,
    amount: "8,000 €",
    recipient: "ale",
    layout: "cropped_phone",
  });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const res = await analyzeReceipt(buf);

  assert.equal(res.status, "ok");
  assert.equal(res.fields.amount, 8000);
  assert.equal(res.fields.recipient, "ale");
});

test("analyzeReceipt: tightly cropped dialog card OCR extracts 15,500 € to Officer_Max", async () => {
  const svg = makeEhScreenshotSvg({
    width: 600,
    height: 320,
    amount: "15,500 €",
    recipient: "Officer_Max",
    layout: "cropped_card",
  });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const res = await analyzeReceipt(buf);

  assert.equal(res.status, "ok");
  assert.equal(res.fields.amount, 15500);
  assert.equal(res.fields.recipient, "Officer_Max");
});

test("analyzeReceipt: night/dark scene screenshot with darker blue modal (#134668) successfully extracts payment", async () => {
  const svg = makeEhScreenshotSvg({
    width: 1920,
    height: 1080,
    time: "02:15",
    balance: "89,200 €",
    amount: "8,000 €",
    recipient: "Chickenwings",
    bgColor: "#0f172a",
    modalColor: "#134668",
    layout: "full",
  });
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  const res = await analyzeReceipt(buf);

  assert.equal(res.status, "ok");
  assert.equal(res.fields.amount, 8000);
  assert.equal(res.fields.recipient, "Chickenwings");
  assert.equal(res.diagnostics.status, OCR_STATUS.OK);
});
