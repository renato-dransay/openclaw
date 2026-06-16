/** Normalizes isolated cron run output into summaries, delivery payloads, and error state. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { DEFAULT_HEARTBEAT_ACK_MAX_CHARS } from "../../auto-reply/heartbeat.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { truncateUtf16Safe } from "../../utils.js";
import { shouldSkipHeartbeatOnlyDelivery } from "../heartbeat-policy.js";

const CRON_DENIAL_EXACT_TOKENS = ["SYSTEM_RUN_DENIED", "INVALID_REQUEST"] as const;
const CRON_DENIAL_CASE_INSENSITIVE_TOKENS = [
  "approval cannot safely bind",
  "runtime denied",
  "could not run",
  "did not run",
  "was denied",
] as const;

/**
 * Detects a "cron denial" marker in agent output — a token indicating the run
 * was refused/denied rather than completed normally. Returns the matched token,
 * or undefined when none is present. Restored here after a branch merge dropped
 * the definition while leaving the call site below intact.
 */
export function detectCronDenialToken(text: string | undefined): string | undefined {
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return undefined;
  }
  for (const token of CRON_DENIAL_EXACT_TOKENS) {
    if (normalized.includes(token)) {
      return token;
    }
  }
  const lowerText = normalized.toLowerCase();
  for (const token of CRON_DENIAL_CASE_INSENSITIVE_TOKENS) {
    if (lowerText.includes(token)) {
      return token;
    }
  }
  return undefined;
}

type DeliveryPayload = Pick<
  ReplyPayload,
  "text" | "mediaUrl" | "mediaUrls" | "presentation" | "interactive" | "channelData" | "isError"
>;

/** Normalized cron run payload state used for summaries, delivery, and failure classification. */
export type CronPayloadOutcome = {
  summary?: string;
  outputText?: string;
  synthesizedText?: string;
  deliveryPayload?: DeliveryPayload;
  deliveryPayloads: DeliveryPayload[];
  deliveryPayloadHasStructuredContent: boolean;
  hasFatalErrorPayload: boolean;
  hasFatalStructuredErrorPayload: boolean;
  embeddedRunError?: string;
  pendingPresentationWarningError?: string;
};

type CronFailureSignal = {
  kind?: string;
  source?: string;
  toolName?: string;
  code?: string;
  message?: string;
  fatalForCron?: boolean;
};

type NormalizedCronFailureSignal = CronFailureSignal & {
  message: string;
  fatalForCron: true;
};

function normalizeCronFailureSignal(
  signal: CronFailureSignal | undefined,
): NormalizedCronFailureSignal | undefined {
  // Only explicit fatal signals become cron failures; ordinary tool warnings
  // still need payload/output evidence before failing the run.
  const message = normalizeOptionalString(signal?.message);
  if (signal?.fatalForCron !== true || !message) {
    return undefined;
  }
  return { ...signal, message, fatalForCron: true };
}

function formatCronFailureSignal(signal: NormalizedCronFailureSignal): string {
  const kind = normalizeOptionalString(signal.kind) ?? "run";
  const code = normalizeOptionalString(signal.code);
  const source = normalizeOptionalString(signal.toolName) ?? normalizeOptionalString(signal.source);
  return `cron classifier: ${kind} failure${source ? ` from ${source}` : ""}${
    code ? ` (${code})` : ""
  }: ${signal.message}`;
}

function formatCronRunLevelError(error: unknown): string | undefined {
  const direct = normalizeOptionalString(error);
  if (direct) {
    return `cron isolated run failed: ${direct}`;
  }
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const record = error as { message?: unknown; kind?: unknown };
  const message = normalizeOptionalString(record.message);
  if (message) {
    return `cron isolated run failed: ${message}`;
  }
  const kind = normalizeOptionalString(record.kind);
  if (kind) {
    return `cron isolated run failed: ${kind}`;
  }
  return "cron isolated run failed";
}

/** Picks a bounded cron run summary from plain text output. */
export function pickSummaryFromOutput(text: string | undefined) {
  const clean = (text ?? "").trim();
  if (!clean) {
    return undefined;
  }
  const limit = 2000;
  return clean.length > limit ? `${truncateUtf16Safe(clean, limit)}…` : clean;
}

/** Picks the last non-error payload text suitable for cron run summaries. */
export function pickSummaryFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (isNonTerminalToolErrorWarning(payloads[i])) {
      continue;
    }
    const summary = pickSummaryFromOutput(payloads[i]?.text);
    if (summary) {
      return summary;
    }
  }
  return undefined;
}

/** Picks the last non-empty payload text while ignoring terminal error payloads first. */
export function pickLastNonEmptyTextFromPayloads(
  payloads: Array<{ text?: string | undefined; isError?: boolean }>,
) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (isNonTerminalToolErrorWarning(payloads[i])) {
      continue;
    }
    const clean = (payloads[i]?.text ?? "").trim();
    if (clean) {
      return clean;
    }
  }
  return undefined;
}

function isDeliverablePayload(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  return hasOutboundReplyContent(payload, { trimText: true });
}

function payloadHasStructuredDeliveryContent(payload: DeliveryPayload | null | undefined): boolean {
  if (!payload) {
    return false;
  }
  return (
    payload.mediaUrl !== undefined ||
    (payload.mediaUrls?.length ?? 0) > 0 ||
    (payload.presentation?.blocks?.length ?? 0) > 0 ||
    (payload.interactive?.blocks?.length ?? 0) > 0 ||
    Object.keys(payload.channelData ?? {}).length > 0
  );
}

/** Picks the last payload with deliverable outbound content, preferring non-error payloads. */
export function pickLastDeliverablePayload(payloads: DeliveryPayload[]) {
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (payloads[i]?.isError) {
      continue;
    }
    if (isDeliverablePayload(payloads[i])) {
      return payloads[i];
    }
  }
  for (let i = payloads.length - 1; i >= 0; i--) {
    if (isDeliverablePayload(payloads[i])) {
      return payloads[i];
    }
  }
  return undefined;
}

/** Selects deliverable cron payloads while preserving multi-payload successful responses. */
export function pickDeliverablePayloads(payloads: DeliveryPayload[]): DeliveryPayload[] {
  const successfulDeliverablePayloads = payloads.filter(
    (payload) => payload != null && payload.isError !== true && isDeliverablePayload(payload),
  );
  if (successfulDeliverablePayloads.length > 0) {
    return successfulDeliverablePayloads;
  }
  const lastDeliverablePayload = pickLastDeliverablePayload(payloads);
  return lastDeliverablePayload ? [lastDeliverablePayload] : [];
}

/**
 * Check if delivery should be skipped because the agent signaled no user-visible update.
 * Returns true when any payload is a heartbeat ack token and no payload contains media.
 */
export function isHeartbeatOnlyResponse(payloads: DeliveryPayload[], ackMaxChars: number) {
  return shouldSkipHeartbeatOnlyDelivery(payloads, ackMaxChars);
}

/** Resolves the non-negative heartbeat ack length used for heartbeat-only filtering. */
export function resolveHeartbeatAckMaxChars(agentCfg?: { heartbeat?: { ackMaxChars?: number } }) {
  const raw = agentCfg?.heartbeat?.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
  return Math.max(0, raw);
}

function isMidTurnToolFailureText(text: string | undefined): boolean {
  const normalized = normalizeOptionalString(text);
  if (!normalized) {
    return false;
  }
  // tool-display formats failed agent-issued tool calls as "⚠️ 🛠️ <summary>
  // failed" (the 🛠️ wrench is the tool emoji). Provider/model/run-level
  // failures use other shapes (plain text or different emoji prefixes).
  return normalized.startsWith("⚠️ 🛠️") && normalized.endsWith("failed");
}

function isCronMessagePresentationWarning(text: string | undefined): boolean {
  const normalized = normalizeOptionalString(text)?.toLowerCase();
  return (
    normalized === "⚠️ ✉️ message failed" ||
    normalized?.startsWith("⚠️ ✉️ message failed:") === true
  );
}

function isCronToolWarning(text: string | undefined): boolean {
  return normalizeOptionalString(text)?.startsWith("⚠️ 🛠️ ") === true;
}

function isNonTerminalToolErrorWarning(payload: object | undefined): boolean {
  return Boolean(payload && getReplyPayloadMetadata(payload)?.nonTerminalToolErrorWarning);
}

function isSuccessfulCronPayload(payload: DeliveryPayload | undefined): boolean {
  return (
    payload?.isError !== true &&
    (isDeliverablePayload(payload) || payloadHasStructuredDeliveryContent(payload))
  );
}

/** Resolves summary, output text, delivery payloads, and fatal-error state from cron run output. */
export function resolveCronPayloadOutcome(params: {
  payloads: DeliveryPayload[];
  runLevelError?: unknown;
  failureSignal?: CronFailureSignal | undefined;
  finalAssistantVisibleText?: string | undefined;
  preferFinalAssistantVisibleText?: boolean;
}): CronPayloadOutcome {
  const firstText =
    params.payloads.find((payload) => !isNonTerminalToolErrorWarning(payload))?.text ?? "";
  const fallbackSummary =
    pickSummaryFromPayloads(params.payloads) ?? pickSummaryFromOutput(firstText);
  const fallbackOutputText = pickLastNonEmptyTextFromPayloads(params.payloads);
  const deliveryPayload = pickLastDeliverablePayload(params.payloads);
  const selectedDeliveryPayloads = pickDeliverablePayloads(params.payloads);
  const deliveryPayloadHasStructuredContent = payloadHasStructuredDeliveryContent(deliveryPayload);
  const hasErrorPayload = params.payloads.some((payload) => payload?.isError === true);
  const lastErrorPayloadIndex = params.payloads.findLastIndex(
    (payload) => payload?.isError === true,
  );
  const lastErrorPayloadText = [...params.payloads]
    .toReversed()
    .find((payload) => payload?.isError === true && Boolean(payload?.text?.trim()))
    ?.text?.trim();
  const errorPayloads = params.payloads.filter((payload) => payload?.isError === true);
  const normalizedFinalAssistantVisibleText = normalizeOptionalString(
    params.finalAssistantVisibleText,
  );
  // When the trailing error payload is a mid-turn tool-display failure
  // (format "⚠️ 🛠️ <summary> failed") and the agent went on to produce a
  // clean final assistant message, treat the final message as an implicit
  // success payload after the error. Codex's openai-codex bridge surfaces
  // the final answer via finalAssistantVisibleText but doesn't re-emit it
  // as a delivery payload when delivery isn't requested, so without this
  // we'd mark green cron runs as fatal whenever the agent made a harmless
  // exit-non-zero exec call (e.g. probing `cli.js workflow --help`).
  // Provider/model/run-level errors use other payload shapes and stay
  // fatal; the tool-emoji prefix is the discriminator.
  const finalAssistantTextForRecovery = normalizeOptionalString(params.finalAssistantVisibleText);
  const finalAssistantTextSignalsRecovery =
    !params.runLevelError &&
    Boolean(finalAssistantTextForRecovery) &&
    !isCronMessagePresentationWarning(finalAssistantTextForRecovery) &&
    detectCronDenialToken(finalAssistantTextForRecovery) === undefined;
  const lastErrorPayloadIsMidTurnToolFailure =
    lastErrorPayloadIndex >= 0 &&
    isMidTurnToolFailureText(params.payloads[lastErrorPayloadIndex]?.text);
  const hasSuccessfulPayloadAfterLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex >= 0 &&
    (params.payloads
      .slice(lastErrorPayloadIndex + 1)
      .some((payload) => payload?.isError !== true && Boolean(payload?.text?.trim())) ||
      (finalAssistantTextSignalsRecovery && lastErrorPayloadIsMidTurnToolFailure));
  const hasSuccessfulPayloadBeforeLastError =
    !params.runLevelError &&
    lastErrorPayloadIndex > 0 &&
    params.payloads.slice(0, lastErrorPayloadIndex).some(isSuccessfulCronPayload);
  const lastErrorPayload =
    lastErrorPayloadIndex >= 0 ? params.payloads[lastErrorPayloadIndex] : undefined;
  const hasRecoveringTerminalOutput =
    normalizedFinalAssistantVisibleText !== undefined ||
    hasSuccessfulPayloadAfterLastError ||
    hasSuccessfulPayloadBeforeLastError;
  // Some tools emit warning/error payloads before a final answer. Treat those
  // as non-terminal only when later visible output proves the run recovered.
  const hasNonTerminalToolErrorWarning =
    !params.runLevelError &&
    params.failureSignal?.fatalForCron !== true &&
    hasRecoveringTerminalOutput &&
    isNonTerminalToolErrorWarning(lastErrorPayload);
  const hasPendingPresentationWarning =
    !params.runLevelError &&
    params.failureSignal?.fatalForCron !== true &&
    lastErrorPayloadIndex >= 0 &&
    isCronMessagePresentationWarning(lastErrorPayloadText) &&
    (normalizedFinalAssistantVisibleText !== undefined || hasSuccessfulPayloadBeforeLastError);
  const hasStructuredDeliveryPayloads = selectedDeliveryPayloads.some((payload) =>
    payloadHasStructuredDeliveryContent(payload),
  );
  const hasRecoveredToolWarning =
    !params.runLevelError &&
    params.failureSignal?.fatalForCron !== true &&
    params.preferFinalAssistantVisibleText === true &&
    normalizedFinalAssistantVisibleText !== undefined &&
    !hasStructuredDeliveryPayloads &&
    errorPayloads.length > 0 &&
    errorPayloads.every((payload) => isCronToolWarning(payload?.text));
  // Structured error payloads are fatal unless later successful output or a
  // known non-terminal warning proves the agent recovered.
  const hasFatalStructuredErrorPayload =
    hasErrorPayload &&
    !hasSuccessfulPayloadAfterLastError &&
    !hasPendingPresentationWarning &&
    !hasNonTerminalToolErrorWarning &&
    !hasRecoveredToolWarning;
  // Fatal structured errors own the final delivery payload unless later output
  // proves recovery; otherwise cron would announce stale partial success text.
  // Keep structured/media announce payloads intact. Only collapse purely textual
  // cron announce output to the final assistant-visible answer.
  // A final assistant answer can replace textual warning payloads, but never
  // structured/media payloads that carry the actual delivery content.
  const shouldUseFinalAssistantVisibleText =
    params.preferFinalAssistantVisibleText === true &&
    normalizedFinalAssistantVisibleText !== undefined &&
    !hasFatalStructuredErrorPayload &&
    !hasStructuredDeliveryPayloads;
  const summary = shouldUseFinalAssistantVisibleText
    ? (pickSummaryFromOutput(normalizedFinalAssistantVisibleText) ?? fallbackSummary)
    : fallbackSummary;
  const outputText = shouldUseFinalAssistantVisibleText
    ? normalizedFinalAssistantVisibleText
    : fallbackOutputText;
  const synthesizedText = normalizeOptionalString(outputText) ?? normalizeOptionalString(summary);
  const resolvedDeliveryPayloads = shouldUseFinalAssistantVisibleText
    ? [{ text: normalizedFinalAssistantVisibleText }]
    : selectedDeliveryPayloads.length > 0
      ? selectedDeliveryPayloads
      : synthesizedText
        ? [{ text: synthesizedText }]
        : [];
  const failureSignal = normalizeCronFailureSignal(params.failureSignal);
  const runLevelError = formatCronRunLevelError(params.runLevelError);
  const hasFatalErrorPayload =
    hasFatalStructuredErrorPayload || failureSignal !== undefined || runLevelError !== undefined;
  const structuredErrorText = hasFatalStructuredErrorPayload
    ? (lastErrorPayloadText ?? "cron isolated run returned an error payload")
    : undefined;
  const shouldUseRunLevelErrorPayload =
    runLevelError !== undefined && structuredErrorText === undefined && failureSignal === undefined;
  const fatalDeliveryText =
    structuredErrorText ??
    failureSignal?.message ??
    (shouldUseRunLevelErrorPayload ? runLevelError : undefined);
  const fatalDeliveryPayload = fatalDeliveryText
    ? ({ text: fatalDeliveryText, isError: true } satisfies DeliveryPayload)
    : undefined;
  return {
    summary: fatalDeliveryText ? (pickSummaryFromOutput(fatalDeliveryText) ?? summary) : summary,
    outputText: fatalDeliveryText ?? outputText,
    synthesizedText: fatalDeliveryText ?? synthesizedText,
    deliveryPayload: fatalDeliveryPayload ?? deliveryPayload,
    deliveryPayloads: fatalDeliveryPayload ? [fatalDeliveryPayload] : resolvedDeliveryPayloads,
    deliveryPayloadHasStructuredContent: fatalDeliveryPayload
      ? false
      : deliveryPayloadHasStructuredContent,
    hasFatalErrorPayload,
    hasFatalStructuredErrorPayload,
    embeddedRunError: structuredErrorText
      ? structuredErrorText
      : failureSignal
        ? formatCronFailureSignal(failureSignal)
        : runLevelError,
    pendingPresentationWarningError: hasPendingPresentationWarning
      ? lastErrorPayloadText
      : undefined,
  };
}
