import assert from "node:assert/strict";
import test from "node:test";
import { AMOUNT_MISMATCH, AMOUNT_MATCH, AMOUNT_NEEDS_REVIEW, buildAmountCheckerMessage, checkScreenshotAmount, describeAmountComparison } from "./amount-checker.js";

test("matching labelled amounts return MATCH for comma, plain, and space formatting", () => {
  for (const text of ["You paid $5,000 to IRP Treasury", "Amount: 5000", "Amount:\n5 000"]) {
    const check = checkScreenshotAmount(text, 5000);
    assert.equal(check.comparison, AMOUNT_MATCH);
    assert.equal(check.extractedAmount, 5000);
  }
});

test("labelled amounts that differ return MISMATCH with the extracted value", () => {
  const check = checkScreenshotAmount("Payment sent: $3,000", 5000);
  assert.equal(check.comparison, AMOUNT_MISMATCH);
  assert.equal(check.extractedAmount, 3000);
});

test("formatted numbers parse correctly: 5,000 / 5000 / 5 000 / 12.500", () => {
  for (const [text, expected] of [["Amount: 5,000", 5000], ["Amount: 5000", 5000], ["Amount: 5 000", 5000], ["Amount: 12.500", 12500], ["Amount: 12,500", 12500]]) {
    const check = checkScreenshotAmount(text, expected);
    assert.equal(check.comparison, AMOUNT_MATCH, text);
    assert.equal(check.extractedAmount, expected, text);
  }
});

test("balances, fees, account/receipt/transaction IDs, and nearby dates are ignored", () => {
  const check = checkScreenshotAmount("Balance: 12,000\nFee: 250\nUser ID: 114936940\nReceipt #55831\nAmount: 5,000", 5000);
  assert.equal(check.comparison, AMOUNT_MATCH);
  assert.equal(check.extractedAmount, 5000);
  assert.ok(check.excludedCount >= 3);
});

test("date and time digits never become the payment amount", () => {
  const check = checkScreenshotAmount("Date: 2024-01-15\nTime: 14:30\nAmount: 5,000", 5000);
  assert.equal(check.comparison, AMOUNT_MATCH);
  assert.equal(check.extractedAmount, 5000);
});

test("a strong amount label beats other transaction wording nearby", () => {
  const check = checkScreenshotAmount("Total transferred: 4,500\nAmount paid: 3,000", 3000);
  assert.equal(check.comparison, AMOUNT_MATCH);
  assert.equal(check.extractedAmount, 3000);
});

test("multiple contradicting labelled amounts stay unresolved (NEEDS_REVIEW)", () => {
  const check = checkScreenshotAmount("Paid: 3,000\nAmount: 5,000", 3000);
  assert.equal(check.comparison, AMOUNT_NEEDS_REVIEW);
  assert.equal(check.extractedAmount, null);
});

test("a claimed amount is never accepted merely because the number appears in the image", () => {
  const check = checkScreenshotAmount("Statement shows 5000 and 3,000 in sidebar", 5000);
  assert.equal(check.comparison, AMOUNT_NEEDS_REVIEW);
  assert.equal(check.extractedAmount, null);
});

test("numbers introduced by weak transaction wording alone are not confident either", () => {
  const check = checkScreenshotAmount("Purchases page shows 3000 items tracked", 3000);
  assert.equal(check.comparison, AMOUNT_NEEDS_REVIEW);
  assert.equal(check.extractedAmount, null);
});

test("unreadable or digit-free screenshots resolve to NEEDS_REVIEW", () => {
  for (const text of ["", " ", "blurry image, nothing readable", "Receipt could not be processed"]) {
    const check = checkScreenshotAmount(text, 5000);
    assert.equal(check.comparison, AMOUNT_NEEDS_REVIEW);
    assert.equal(check.extractedAmount, null);
  }
});

test("a missing or invalid claimed amount prevents any comparison", () => {
  const check = checkScreenshotAmount("Amount: 5,000", undefined);
  assert.equal(check.comparison, AMOUNT_NEEDS_REVIEW);
  assert.equal(check.extractedAmount, null);
  assert.equal(check.claimedAmount, null);
});

test("decimal amounts outside the in-game whole-number format are not guessed", () => {
  const check = checkScreenshotAmount("Amount: 5,000.50", 5000);
  assert.equal(check.comparison, AMOUNT_NEEDS_REVIEW);
  assert.equal(check.extractedAmount, null);
});

test("amounts beyond the supported command limit are ignored", () => {
  const check = checkScreenshotAmount("Sent: 9,999,999,999\nAmount: 5,000", 5000);
  assert.equal(check.comparison, AMOUNT_MATCH);
  assert.equal(check.extractedAmount, 5000);
});

test("comparison descriptors cover every outcome including legacy rows", () => {
  assert.match(describeAmountComparison(AMOUNT_MATCH), /MATCH/);
  assert.match(describeAmountComparison(AMOUNT_MISMATCH), /MISMATCH/);
  assert.match(describeAmountComparison(AMOUNT_NEEDS_REVIEW), /NEEDS_REVIEW/);
  assert.match(describeAmountComparison(null), /not recorded/);
});

test("player reply matches the PTB response spec for all three outcomes", () => {
  const match = buildAmountCheckerMessage({ comparison: AMOUNT_MATCH, claimedAmount: 5000, extractedAmount: 5000, status: "PENDING", reference: "IRPT-000001" });
  assert.match(match, /🟢 Amount Match/);
  assert.match(match, /Claimed amount: \$5,000/);
  assert.match(match, /Screenshot amount: \$5,000/);
  assert.match(match, /The amounts match\./);
  assert.match(match, /Status: Pending manual verification\./);

  const mismatch = buildAmountCheckerMessage({ comparison: AMOUNT_MISMATCH, claimedAmount: 5000, extractedAmount: 3000, status: "NEEDS_REVIEW", reference: "IRPT-000002" });
  assert.match(mismatch, /🔴 Amount Mismatch/);
  assert.match(mismatch, /Claimed amount: \$5,000/);
  assert.match(mismatch, /Screenshot amount: \$3,000/);
  assert.match(mismatch, /The amounts do not match\./);
  assert.match(mismatch, /Status: Flagged for review\./);

  const unreadable = buildAmountCheckerMessage({ comparison: AMOUNT_NEEDS_REVIEW, claimedAmount: 5000, extractedAmount: null, status: "NEEDS_REVIEW", reference: "IRPT-000003" });
  assert.match(unreadable, /🟡 Unable to Read Amount/);
  assert.match(unreadable, /could not confidently identify/);
  assert.match(unreadable, /Please submit a clearer screenshot\./);
  assert.match(unreadable, /Status: Needs review\./);
  assert.doesNotMatch(unreadable, /Claimed amount:/);
});
