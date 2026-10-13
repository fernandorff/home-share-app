import { addBreadcrumb } from "@sentry/nextjs";
import { redactText } from "@/lib/observability/scrub";

// Server logging (spec 007): one JSON line per call — Vercel keeps the stream per level (stdout vs
// stderr) and log drains parse the JSON — plus a Sentry breadcrumb, so the next captured error in the
// same request carries the trail. The only console sink in src/ (enforced by logger.test.ts).

export type LogLevel = "info" | "warn" | "error";
export type LogValue = string | number | boolean | undefined;

export interface LogFields {
  requestId?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  [key: string]: LogValue;
}

interface SerializedError {
  name?: string;
  message: string;
  stack?: string;
}

// A URL query string can carry OAuth codes and set-password tokens; redactText does not cover it.
const URL_QUERY = /\?[\w%.~=-][^\s"'`]*/g;

/** Everything logged is text a person may read in Vercel or Sentry: no e-mails, secrets or query strings. */
function redactLogText(text: string): string {
  return redactText(text).replace(URL_QUERY, "");
}

const SINKS: Record<LogLevel, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

const STACK_FRAME = /^\s+at /;

function lastLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
}

// The "    at ..." lines that close a stack (a multi-line message ahead of them is not part of the run).
function stackFrames(stack: string): string[] {
  const lines = stack.split("\n");
  let first = lines.length;
  while (first > 0 && STACK_FRAME.test(lines[first - 1])) first--;
  return lines.slice(first);
}

// Prisma's "Invalid `prisma.x.y()` invocation" message prints the query arguments (names, amounts), and
// the stack repeats it: keep the final reason line, like scrubEvent does for Sentry (spec 007, LGPD).
function serializePrismaError(error: Error): SerializedError {
  const message = lastLine(error.message);
  const frames = error.stack ? stackFrames(error.stack) : [];
  return {
    name: error.name,
    message: redactLogText(message),
    stack: redactLogText([`${error.name}: ${message}`, ...frames].join("\n")),
  };
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    if (error.name.startsWith("PrismaClient")) return serializePrismaError(error);
    return { name: error.name, message: redactLogText(error.message), stack: error.stack ? redactLogText(error.stack) : undefined };
  }
  return { message: redactLogText(String(error)) };
}

function definedFields(fields: LogFields): Record<string, string | number | boolean> {
  const defined: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) defined[key] = typeof value === "string" ? redactLogText(value) : value;
  }
  return defined;
}

// Fixed on purpose: when logging itself fails there is nothing safe to say about the entry.
const LOGGER_FAILURE_LINE = JSON.stringify({ level: "error", msg: "logger failed to write a log entry" });

// Never throws: it runs inside catch blocks (handleApiError) and best-effort audit paths, where a
// throwing logger would replace the intended response or break an operation that must succeed.
export function log(level: LogLevel, msg: string, fields: LogFields = {}, error?: unknown): void {
  try {
    const data = definedFields(fields);
    const message = redactLogText(msg);
    const entry = {
      time: new Date().toISOString(),
      level,
      msg: message,
      ...data,
      ...(error === undefined ? {} : { error: serializeError(error) }),
    };
    SINKS[level](JSON.stringify(entry));
    addBreadcrumb({ category: "log", level: level === "warn" ? "warning" : level, message, data });
  } catch {
    try {
      console.error(LOGGER_FAILURE_LINE);
    } catch {
      // The console itself is broken: nowhere left to report to.
    }
  }
}

export const logger = {
  info: (msg: string, fields?: LogFields) => log("info", msg, fields),
  warn: (msg: string, fields?: LogFields, error?: unknown) => log("warn", msg, fields, error),
  error: (msg: string, fields?: LogFields, error?: unknown) => log("error", msg, fields, error),
};
