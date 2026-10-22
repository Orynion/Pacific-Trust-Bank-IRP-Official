// PTB automatic screenshot amount checker.
//
// Extracts the payment amount displayed on an in-game payment screenshot from
// OCR text and compares it numerically against the amount the player claimed
// with /treasury-submit. Outcome values:
//   MATCH        — a transaction-labelled amount was read and equals the claim.
//   MISMATCH     — a transaction-labelled amount was read and differs from the claim.
//   NEEDS_REVIEW — no amount could be identified confidently (never guessed).
//
// Safety rules encoded here:
//   - Only numbers introduced by transaction wording ("Amount:", "paid",
//     "Total:", "Sent", and similar) may be treated as the paid amount.
//   - A claimed amount is never accepted merely because the same number
//     appears somewhere in the screenshot with no transaction label.
//   - Numbers sent to balances, fees, account/receipt/transaction IDs, dates
//     and times are excluded from the comparison.
//   - Multiple contradicting labelled amounts are ambiguous and resolve to
//     NEEDS_REVIEW instead of guessing.
//   - A match is not proof of a genuine payment and a mismatch is not
//     automatic proof of fraud; human treasury review is always required.

export const AMOUNT_MATCH = "MATCH";
export const AMOUNT_MISMATCH = "MISMATCH";
export const AMOUNT_NEEDS_REVIEW = "NEEDS_REVIEW";
export const AMOUNT_COMPARISON_VALUES = [AMOUNT_MATCH, AMOUNT_MISMATCH, AMOUNT_NEEDS_REVIEW];

// Amounts in this bot are positive whole numbers up to the 32-bit command limit.
const maxSupportedAmount = 2_147_483_647;

// Label wording that explicitly denotes the transaction amount.
const TIER1_LABEL = /\b(?:amount|paid|payment|pay)\b/i;
// Other transaction wording that contextually denotes a money figure.
const TIER2_LABEL = /\b(?:total|transfers?|transferred|sents?|deposits?|deposited|debits?|debited|charged|charge|deducts?|deducted|purchases?|purchased)\b/i;
// Context that marks a nearby number as NOT the transaction amount. Checked
// against the number's own line only, so wording on a neighbouring line
// ("Time: 14:30" above an amount line) can never suppress a labelled amount.
const EXCLUDE_CONTEXT = /\b(?:balance|bal|fees?|accounts?|ids?|refs?|references?|receipts?|transactions?|dates?|times?|levels?|xp|wallets?|cards?|numbers?)\b|#/i;

const labelCloseChars = 10;
const excludeWithinChars = 14;
// $5,000 / €3,000 / "12 500" / "5.000" style tokens. The separator run also
// tolerates OCR spacing variations such as "5, 000".
const candidatePattern = /(?:[$€£]\s*)?\d+(?:[ \u00A0.,]+\d+)*/g;

function parseAmountToken(token) {
  const cleaned = token.replace(/[$€£]/g, " ").trim().replace(/^[^\d]+|[^\d]+$/g, "");
  if (!/\d/.test(cleaned)) return null;
  const parts = cleaned.split(/[ \u00A0.,]+/);
  if (!parts.length || !parts.every((part) => /^\d+$/.test(part))) return null;
  if (parts.length === 1) return { value: Number(parts[0]), integer: true };
  const tail = parts[parts.length - 1];
  if (parts.slice(1).every((part) => part.length === 3)) {
    // 5,000 / 5 000 / 12.500 — thousands grouping.
    return { value: Number(parts.join("")), integer: true };
  }
  const head = parts.slice(0, -1);
  if (tail.length <= 2 && head.every((part) => part.length === 3)) {
    // 5,000.50 — thousands grouping followed by a decimal remainder.
    return { value: Number(`${head.join("")}.${tail}`), integer: false };
  }
  if (parts.length === 2 && tail.length <= 2) {
    // 5,50 / 12,30 — decimal separator reading.
    return { value: Number(`${parts[0]}.${tail}`), integer: false };
  }
  return null;
}

// Dates and times (2024-01-15, 15/01/2024, 14:30[:45]) are masked before
// scanning so their digits can never be read as amounts.
function maskTemporalNumbers(text) {
  return text
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
}

function contextExcluded(line, localStart, tokenLength) {
  const before = line.slice(Math.max(0, localStart - excludeWithinChars), localStart);
  const after = line.slice(localStart + tokenLength, localStart + tokenLength + excludeWithinChars);
  return EXCLUDE_CONTEXT.test(before) || EXCLUDE_CONTEXT.test(after);
}

function needsReview({ reason, claimed, candidateCount = 0, labeledCount = 0, excludedCount = 0 }) {
  return {
    comparison: AMOUNT_NEEDS_REVIEW,
    extractedAmount: null,
    claimedAmount: Number.isSafeInteger(claimed) && claimed >= 1 ? claimed : null,
    reason,
    candidateCount,
    labeledCount,
    excludedCount,
  };
}

export function checkScreenshotAmount(ocrText, claimedAmount) {
  const claimed = Number(claimedAmount);
  if (!String(ocrText ?? "").trim()) return needsReview({ reason: "OCR_TEXT_UNREADABLE", claimed });
  if (!Number.isSafeInteger(claimed) || claimed < 1) return needsReview({ reason: "CLAIMED_AMOUNT_MISSING", claimed: null });

  const candidates = [];
  const lines = maskTemporalNumbers(String(ocrText)).split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/\s+/g, " ").trim();
    if (!line) continue;
    for (const match of line.matchAll(candidatePattern)) {
      const parsed = parseAmountToken(match[0]);
      if (!parsed || parsed.value < 1 || parsed.value > maxSupportedAmount) continue;
      candidates.push({ value: parsed.value, integer: parsed.integer, lineIndex, localStart: match.index, length: match[0].length });
    }
  }
  if (!candidates.length) return needsReview({ reason: "AMOUNT_NOT_RECOGNIZED", claimed });

  // Candidates are assigned a label rank: 3 = explicit amount wording just
  // before the number, 2 = other transaction wording nearby, 1 = weak
  // transaction wording. Numbers split across a line wrap are deliberately
  // not merged: without a label such tokens stay inconclusive anyway.
  const labeled = [];
  let excludedCount = 0;
  for (const candidate of candidates) {
    const line = lines[candidate.lineIndex].replace(/\s+/g, " ").trim();
    const prevLine = candidate.lineIndex > 0 ? lines[candidate.lineIndex - 1].replace(/\s+/g, " ").trim() : "";
    const windowText = `${prevLine}\n${line}`;
    const tokenStart = prevLine.length + 1 + candidate.localStart;
    if (contextExcluded(line, candidate.localStart, candidate.length)) {
      excludedCount += 1;
      continue;
    }
    const closeBefore = windowText.slice(Math.max(0, tokenStart - labelCloseChars), tokenStart);
    const lineBefore = line.slice(0, candidate.localStart);
    const tier1Close = TIER1_LABEL.test(closeBefore);
    const tier2Close = TIER2_LABEL.test(closeBefore);
    const tier1Line = TIER1_LABEL.test(lineBefore);
    const tier2Line = TIER2_LABEL.test(lineBefore);
    const tier1Prev = Boolean(prevLine) && TIER1_LABEL.test(prevLine);
    const tier2Prev = Boolean(prevLine) && TIER2_LABEL.test(prevLine);
    const rank = tier1Close ? 3 : (tier2Close || tier1Line || tier1Prev) ? 2 : (tier2Line || tier2Prev) ? 1 : 0;
    if (rank >= 1) labeled.push({ ...candidate, rank });
  }

  const strongLabeled = labeled.filter((candidate) => candidate.rank >= 2 && candidate.integer);
  if (!strongLabeled.length) {
    if (labeled.some((candidate) => candidate.rank >= 2)) return needsReview({ reason: "NON_INTEGER_AMOUNT", claimed, candidateCount: candidates.length, labeledCount: labeled.length, excludedCount });
    if (labeled.length) return needsReview({ reason: "NO_PRIMARY_TRANSACTION_LABEL", claimed, candidateCount: candidates.length, labeledCount: labeled.length, excludedCount });
    return needsReview({ reason: "NO_TRANSACTION_LABEL", claimed, candidateCount: candidates.length, excludedCount });
  }

  const topRank = Math.max(...strongLabeled.map((candidate) => candidate.rank));
  const top = strongLabeled.filter((candidate) => candidate.rank === topRank);
  const distinctValues = new Set(top.map((candidate) => candidate.value));
  if (distinctValues.size > 1) return needsReview({ reason: "AMBIGUOUS_LABELLED_AMOUNTS", claimed, candidateCount: candidates.length, labeledCount: labeled.length, excludedCount });

  const extractedAmount = top[0].value;
  const comparison = extractedAmount === claimed ? AMOUNT_MATCH : AMOUNT_MISMATCH;
  return {
    comparison,
    extractedAmount,
    claimedAmount: claimed,
    reason: comparison === AMOUNT_MATCH ? "LABELLED_MATCH" : "LABELLED_MISMATCH",
    candidateCount: candidates.length,
    labeledCount: labeled.length,
    excludedCount,
  };
}

export function describeAmountComparison(code) {
  switch (code) {
    case AMOUNT_MATCH: return "MATCH — screenshot amount equals the claimed amount";
    case AMOUNT_MISMATCH: return "MISMATCH — screenshot amount differs from the claimed amount";
    case AMOUNT_NEEDS_REVIEW: return "NEEDS_REVIEW — amount not confidently identified";
    default: return "not recorded for this receipt";
  }
}

function statusWording(status, comparison) {
  switch (status) {
    case "PENDING": return "Pending manual verification.";
    case "NEEDS_REVIEW": return comparison === AMOUNT_NEEDS_REVIEW ? "Needs review." : "Flagged for review.";
    case "DUPLICATE": return "Recorded as a duplicate for review.";
    default: return `${status}.`;
  }
}

const formatAmount = (value) => `$${Number(value).toLocaleString("en-US")}`;

// Ephemeral player reply per the PTB amount-checker response spec.
export function buildAmountCheckerMessage({ comparison, claimedAmount, extractedAmount, status, reference }) {
  const comparisonCode = comparison ?? AMOUNT_NEEDS_REVIEW;
  const header = comparisonCode === AMOUNT_MATCH ? "🟢 Amount Match"
    : comparisonCode === AMOUNT_MISMATCH ? "🔴 Amount Mismatch"
    : "🟡 Unable to Read Amount";
  const lines = [header, ""];
  if (comparisonCode === AMOUNT_NEEDS_REVIEW) {
    lines.push(
      "PTB could not confidently identify the payment amount in your screenshot.",
      "Please submit a clearer screenshot.",
    );
  } else {
    lines.push(
      `Claimed amount: ${formatAmount(claimedAmount)}`,
      `Screenshot amount: ${formatAmount(extractedAmount)}`,
      `Result: The amounts ${comparisonCode === AMOUNT_MATCH ? "match." : "do not match."}`,
    );
  }
  lines.push(`Status: ${statusWording(status, comparisonCode)}`);
  if (reference) lines.push(`Receipt ${reference} — Screenshot analysis is advisory; a treasury reviewer must confirm this payment.`);
  return lines.join("\n");
}
