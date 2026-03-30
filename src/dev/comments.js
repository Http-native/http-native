import { readFileSync, writeFileSync } from "node:fs";

const COMMENT_PREFIX = "[http-native optimization]";
const STATUS_DESCRIPTIONS = {
  "static-fast-path":
    "This route is served by the static fast path and avoids generic bridge dispatch.",
  "native-cache":
    "This route is cached natively in Rust after the first response. Subsequent requests are served directly from native memory until the TTL expires.",
  "bridge-dispatch":
    "This route currently runs through bridge dispatch because it depends on runtime request data.",
  "runtime-cache-tracking":
    "Runtime stability is being tracked to determine whether response caching is safe.",
  "runtime-cache-promoted":
    "This route has been promoted to runtime response cache after stable output was observed.",
};

export function createRouteDevCommentWriter(options = {}) {
  if (
    options?.devComments !== true ||
    options?.hotReload === true ||
    process.env.HTTP_NATIVE_HOT_RELOAD === "1"
  ) {
    return null;
  }

  const applied = new Set();
  const initializedRoutes = new Set();
  const fileState = new Map();

  return {
    markRoute(route, status) {
      const sourceLocation = route?.sourceLocation;
      if (!sourceLocation?.filePath || !Number.isFinite(sourceLocation?.line)) {
        return;
      }

      const normalizedStatus = String(status || "optimized").trim();
      if (!normalizedStatus) {
        return;
      }

      const dedupeKey = `${sourceLocation.filePath}:${sourceLocation.line}:${normalizedStatus}`;
      if (applied.has(dedupeKey)) {
        return;
      }
      applied.add(dedupeKey);

      const routeKey = `${sourceLocation.filePath}:${sourceLocation.line}`;
      const replaceExisting = initializedRoutes.has(routeKey) === false;
      initializedRoutes.add(routeKey);

      annotateFile(
        fileState,
        sourceLocation.filePath,
        sourceLocation.line,
        normalizedStatus,
        { replaceExisting },
      );
    },

    cleanup() {
      for (const [filePath, state] of fileState) {
        cleanupFile(filePath, state);
      }
    },
  };
}

function cleanupFile(filePath, state) {
  if (linesEqual(state.lines, state.baseLines)) {
    return;
  }

  state.lines = [...state.baseLines];
  persistState(filePath, state);
}

function annotateFile(fileState, filePath, sourceLine, status, options = {}) {
  const state = getFileState(fileState, filePath);
  if (!state) {
    return;
  }

  const normalizedLine = normalizeSourceLine(state, sourceLine);

  const effectiveLine =
    normalizedLine + countInsertedBefore(state.insertedAtOriginalLine, normalizedLine);
  const targetIndex = effectiveLine - 1;
  if (targetIndex < 0 || targetIndex >= state.lines.length) {
    return;
  }

  const routeLine = state.lines[targetIndex] ?? "";
  const indent = routeLine.match(/^\s*/)?.[0] ?? "";
  const existingBlock = findExistingOptimizationBlock(state.lines, targetIndex, indent);
  const replaceExisting = options.replaceExisting === true;

  if (existingBlock) {
    const mergedStatuses = replaceExisting
      ? [status]
      : mergeStatuses(existingBlock.statuses, status);
    const replacement = buildOptimizationBlock(indent, mergedStatuses);
    state.lines.splice(
      existingBlock.startIndex,
      existingBlock.endIndex - existingBlock.startIndex + 1,
      ...replacement,
    );
    persistState(filePath, state);
    return;
  }

  const singleLineIndex = targetIndex - 1;
  const singleLineStatuses = parseSingleLineComment(state.lines[singleLineIndex], indent);
  if (singleLineStatuses) {
    const mergedStatuses = replaceExisting
      ? [status]
      : mergeStatuses(singleLineStatuses, status);
    const replacement = buildOptimizationBlock(indent, mergedStatuses);
    state.lines.splice(singleLineIndex, 1, ...replacement);
    state.insertedAtOriginalLine.push({ line: normalizedLine, count: replacement.length - 1 });
    state.insertedAtOriginalLine.sort((left, right) => left.line - right.line);
    persistState(filePath, state);
    return;
  }

  const block = buildOptimizationBlock(indent, [status]);
  state.lines.splice(targetIndex, 0, ...block);
  state.insertedAtOriginalLine.push({ line: normalizedLine, count: block.length });
  state.insertedAtOriginalLine.sort((left, right) => left.line - right.line);
  persistState(filePath, state);
}

function findExistingOptimizationBlock(lines, targetIndex, indent) {
  let cursor = targetIndex - 1;

  while (cursor >= 0 && lines[cursor].trim() === "") {
    cursor -= 1;
  }

  if (cursor < 0 || lines[cursor].trim() !== "*/") {
    return null;
  }

  const endIndex = cursor;
  let startIndex = endIndex;
  while (startIndex >= 0 && !lines[startIndex].trim().startsWith("/**")) {
    startIndex -= 1;
  }

  if (startIndex < 0) {
    return null;
  }

  const blockLines = lines.slice(startIndex, endIndex + 1);
  const hasPrefix = blockLines.some((line) => line.includes(COMMENT_PREFIX));
  if (!hasPrefix) {
    return null;
  }

  const statuses = parseStatusesFromLines(blockLines, indent);
  return {
    startIndex,
    endIndex,
    statuses,
  };
}

function parseSingleLineComment(line, indent) {
  if (typeof line !== "string") {
    return null;
  }

  const prefix = `${indent}// ${COMMENT_PREFIX}`;
  if (!line.startsWith(prefix)) {
    return null;
  }

  return line
    .slice(prefix.length)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseStatusesFromLines(lines) {
  const firstLineWithPrefix = lines.find((line) => line.includes(COMMENT_PREFIX));
  if (!firstLineWithPrefix) {
    return [];
  }

  return firstLineWithPrefix
    .slice(firstLineWithPrefix.indexOf(COMMENT_PREFIX) + COMMENT_PREFIX.length)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildOptimizationBlock(indent, statuses) {
  const dedupedStatuses = [...new Set(statuses.map((value) => String(value).trim()).filter(Boolean))];
  const description = dedupedStatuses
    .map((value) => STATUS_DESCRIPTIONS[value] || `Status '${value}' is active for this route.`)
    .join(" ");

  return [
    `${indent}/** [Auto generated by http-native]`,
    `${indent} * ${COMMENT_PREFIX} ${dedupedStatuses.join(" | ")}`,
    `${indent} * ${description}`,
    `${indent} */`,
  ];
}

function mergeStatuses(existingStatuses, status) {
  const result = [...existingStatuses];
  if (!result.includes(status)) {
    result.push(status);
  }
  return result;
}

function persist(filePath, lines, eol) {
  try {
    writeFileSync(filePath, lines.join(eol), "utf8");
  } catch (error) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[http-native] failed to write dev route comments:", error?.message || error);
    }
  }
}

function getFileState(fileState, filePath) {
  if (!fileState.has(filePath)) {
    let fileText;
    try {
      fileText = readFileSync(filePath, "utf8");
    } catch {
      return null;
    }

    const eol = fileText.includes("\r\n") ? "\r\n" : "\n";
    const lines = fileText.split(/\r?\n/);
    const cleaned = stripGeneratedOptimizationComments(lines);

    fileState.set(filePath, {
      eol,
      lines: [...cleaned.lines],
      baseLines: [...cleaned.lines],
      removedBeforeLine: cleaned.removedBeforeLine,
      insertedAtOriginalLine: [],
    });

    if (!linesEqual(lines, cleaned.lines)) {
      persist(filePath, cleaned.lines, eol);
    }
  }

  return fileState.get(filePath);
}

function normalizeSourceLine(state, sourceLine) {
  const numeric = Number(sourceLine);
  const normalized = Number.isFinite(numeric) ? Math.max(1, Math.floor(numeric)) : 1;
  const lookupIndex = Math.min(normalized, state.removedBeforeLine.length - 1);
  const removed = state.removedBeforeLine[lookupIndex] ?? 0;
  return Math.max(1, normalized - removed);
}

function countInsertedBefore(insertedAtOriginalLine, originalLine) {
  let count = 0;
  for (const entry of insertedAtOriginalLine) {
    if (entry.line <= originalLine) {
      count += entry.count;
    }
  }
  return count;
}

function stripGeneratedOptimizationComments(lines) {
  const output = [];
  const removedBeforeLine = new Array(lines.length + 1).fill(0);
  let removedCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (trimmed.startsWith("//") && trimmed.includes(COMMENT_PREFIX)) {
      removedCount += 1;
      removedBeforeLine[index + 1] = removedCount;
      continue;
    }

    if (trimmed.startsWith("/**")) {
      let endIndex = index;
      while (endIndex < lines.length && lines[endIndex].trim() !== "*/") {
        endIndex += 1;
      }
      if (endIndex < lines.length) {
        const blockLines = lines.slice(index, endIndex + 1);
        const isOptimizationBlock = blockLines.some((entry) => entry.includes(COMMENT_PREFIX));
        if (isOptimizationBlock) {
          for (let cursor = index; cursor <= endIndex; cursor += 1) {
            removedCount += 1;
            removedBeforeLine[cursor + 1] = removedCount;
          }
          index = endIndex;
          continue;
        }
      }
    }

    output.push(line);
    removedBeforeLine[index + 1] = removedCount;
  }

  return {
    lines: output,
    removedBeforeLine,
  };
}

function persistState(filePath, state) {
  persist(filePath, state.lines, state.eol);
}

function linesEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
