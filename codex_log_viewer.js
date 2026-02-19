(() => {
  "use strict";

  const FILTERS_KEY = "codex_viewer_filters_v1";
  const FILTER_OPTIONS = Object.freeze([
    { cls: "user", label: "User", chipClass: "chip-user", checked: true },
    { cls: "assistant", label: "Assistant", chipClass: "chip-assistant", checked: true },
    { cls: "reasoning", label: "Reasoning", chipClass: "chip-reasoning", checked: true },
    { cls: "func-call", label: "Calls", chipClass: "chip-func-call", checked: true },
    { cls: "func-output", label: "Outputs", chipClass: "chip-func-output", checked: true },
    { cls: "plan", label: "Plans", chipClass: "chip-plan", checked: true },
    { cls: "usage", label: "Token Usage", chipClass: "", checked: false },
  ]);
  const DEFAULT_VIEWER_OPTIONS = Object.freeze({
    source: "example.jsonl",
    title: "Codex Session Log",
    collapseOutputCharThreshold: 15000,
    collapseOutputLineThreshold: 300,
    showTokenUsage: false,
  });
  const TOKEN_PRICE_INPUT_PER_1M = 1.75;
  const TOKEN_PRICE_OUTPUT_PER_1M = 14.0;
  const TOKEN_PRICE_INPUT_PER_TOKEN = TOKEN_PRICE_INPUT_PER_1M / 1_000_000;
  const TOKEN_PRICE_OUTPUT_PER_TOKEN = TOKEN_PRICE_OUTPUT_PER_1M / 1_000_000;
  const DEFAULT_SHOW_CUMULATIVE_COST_OVERLAY = true;
  let mdRenderer = null;
  let interactionsBound = false;

  function esc(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function prettyTimestamp(tsRaw) {
    if (!tsRaw) {
      return "";
    }

    const raw = String(tsRaw);
    const dt = new Date(raw);
    if (!Number.isNaN(dt.getTime())) {
      const pad = (v) => String(v).padStart(2, "0");
      return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    }

    const m = raw.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})/);
    if (m) {
      return `${m[1]} ${m[2]}:${m[3]}:${m[4]}`;
    }
    return raw;
  }

  function parseJsonStringMaybe(value) {
    if (value !== null && typeof value === "object") {
      return [value, true];
    }
    if (typeof value !== "string") {
      return [null, false];
    }
    try {
      return [JSON.parse(value), true];
    } catch {
      return [value, false];
    }
  }

  function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 1) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToUtf8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  function renderMarkdown(text) {
    const src = typeof text === "string" ? text : "";
    if (typeof window.markdownit === "function") {
      if (!mdRenderer) {
        mdRenderer = window.markdownit("commonmark", { html: true });
      }
      return mdRenderer.render(src);
    }
    return src.replace(/\n/g, "<br/>");
  }

  function buildTimestampInline(tsRaw) {
    const pretty = prettyTimestamp(tsRaw);
    return pretty ? `<span class='ts-inline'>${esc(pretty)}</span>` : "";
  }

  function renderReasoning(entry, tsInline) {
    const summaryParts = entry.summary || [];
    const rawTexts = [];
    for (const part of summaryParts) {
      if (part && part.type === "summary_text") {
        rawTexts.push(part.text || "");
      }
    }
    if (!rawTexts.length && typeof entry.text === "string" && entry.text.trim()) {
      rawTexts.push(entry.text);
    }
    const contentHtml = rawTexts.length
      ? renderMarkdown(rawTexts.join("\n\n"))
      : `<pre class='code'>${esc(JSON.stringify(entry, null, 2))}</pre>`;
    return `
    <div class='block reasoning collapsible'>
      <div class='label-row'>
        <div class='label'>Reasoning</div>
        <div class='actions'>
          ${tsInline}
          <button class='toggle' type='button' aria-expanded='true'>Collapse</button>
        </div>
      </div>
      <div class='collapsible-content'>
        <div class='text markdown'>${contentHtml}</div>
      </div>
    </div>
    `;
  }

  function renderMessage(entry, tsInline) {
    const role = entry.role === "user" ? "user" : "assistant";
    const parts = entry.content || [];
    const texts = [];
    for (const part of parts) {
      if (part && typeof part.text === "string") {
        texts.push(part.text);
      }
    }
    const textHtml = renderMarkdown(texts.join("\n\n"));
    const cssClass = role === "user" ? "user" : "assistant";
    const label = role === "user" ? "User" : "Assistant";
    return `
    <div class='block ${cssClass}'>
      <div class='label-row'>
        <div class='label'>${label}</div>
        <div class='actions'>${tsInline}</div>
      </div>
      <div class='text markdown'>${textHtml}</div>
    </div>
    `;
  }

  function renderPlanUpdate(argsObj, tsInline) {
    const explanation = (argsObj && argsObj.explanation) || "";
    const planItems = (argsObj && argsObj.plan) || [];

    function sym(status) {
      const normalized = String(status || "").toLowerCase();
      if (normalized === "completed") return "&#x2705;";
      if (normalized === "in_progress") return "&#x23F3;";
      return "&#x2610;";
    }

    const items = [];
    for (const item of planItems) {
      const step = (item && item.step) || "";
      const status = (item && item.status) || "pending";
      items.push(`<li><span class='plan-sym'>${sym(status)}</span> ${esc(step)}</li>`);
    }

    const explanationHtml = explanation ? `<div class='text markdown'>${renderMarkdown(explanation)}</div>` : "";

    return `
    <div class='block plan'>
      <div class='label-row'>
        <div class='label'>Plan Update</div>
        <div class='actions'>${tsInline}</div>
      </div>
      ${explanationHtml}
      <ul class='plan-list'>${items.join("")}</ul>
    </div>
    `;
  }

  function isPlanUpdateFunctionCall(entry) {
    if (!entry || entry.name !== "update_plan") {
      return false;
    }
    const [argsObj, ok] = parseJsonStringMaybe(entry.arguments);
    return Boolean(ok && argsObj && typeof argsObj === "object" && !Array.isArray(argsObj));
  }

  function extractPatchFromCommand(cmd) {
    if (!Array.isArray(cmd)) {
      return null;
    }
    if (cmd.length >= 2 && String(cmd[0]) === "apply_patch") {
      return String(cmd[1]);
    }
    for (const part of cmd) {
      const s = String(part);
      const m = s.match(/\*\*\* Begin Patch([\s\S]*?)\*\*\* End Patch/);
      if (m) {
        return `*** Begin Patch${m[1]}*** End Patch`;
      }
    }
    return null;
  }

  function renderFunctionCall(entry, tsInline) {
    const name = entry.name || "function";
    const argsRaw = entry.arguments;
    const [argsObj, ok] = parseJsonStringMaybe(argsRaw);

    if (name === "update_plan" && ok && argsObj && typeof argsObj === "object" && !Array.isArray(argsObj)) {
      return renderPlanUpdate(argsObj, tsInline);
    }

    if (ok && argsObj && typeof argsObj === "object" && !Array.isArray(argsObj)) {
      const patchText = extractPatchFromCommand(argsObj.command);
      if (patchText !== null) {
        const rawB64 = utf8ToBase64(patchText);
        return `
    <div class='block func-call collapsible apply-patch' data-raw-b64='${esc(rawB64)}'>
      <div class='label-row'>
        <div class='label'>Apply Patch</div>
        <div class='actions'>
          ${tsInline}
          <button class='toggle' type='button' aria-expanded='true'>Collapse</button>
          <button class='copy' type='button' title='Copy patch to clipboard'>Copy</button>
        </div>
      </div>
      <div class='collapsible-content'>
        <pre class='code diff'><code class='language-diff'>${esc(patchText)}</code></pre>
      </div>
    </div>
    `;
      }
    }

    let body;
    if (ok && argsObj && typeof argsObj === "object" && !Array.isArray(argsObj)) {
      const cmd = argsObj.command;
      if (Array.isArray(cmd)) {
        body = `$ ${esc(cmd.map((c) => String(c)).join(" "))}`;
      } else {
        body = esc(JSON.stringify(argsObj, null, 2));
      }
    } else {
      body = esc(String(argsRaw));
    }

    return `
    <div class='block func-call'>
      <div class='label-row'>
        <div class='label'>Function Call: ${esc(name)}</div>
        <div class='actions'>${tsInline}</div>
      </div>
      <pre class='code'>${body}</pre>
    </div>
    `;
  }

  function renderFunctionOutput(entry, tsInline, options) {
    const [outObj, ok] = parseJsonStringMaybe(entry.output);
    let body;
    if (ok && outObj && typeof outObj === "object" && !Array.isArray(outObj) && Object.prototype.hasOwnProperty.call(outObj, "output")) {
      body = outObj.output;
    } else {
      body = entry.output;
    }
    if (typeof body !== "string") {
      try {
        body = JSON.stringify(body, null, 2);
      } catch {
        body = String(body);
      }
    }
    const charThreshold = options.collapseOutputCharThreshold;
    const lineThreshold = options.collapseOutputLineThreshold;
    const isLarge = body.length >= charThreshold || body.split("\n").length >= lineThreshold;
    const collapsedClass = isLarge ? " collapsed" : "";
    const ariaExpanded = isLarge ? "false" : "true";
    const toggleLabel = isLarge ? "Expand" : "Collapse";

    return `
    <div class='block func-output collapsible${collapsedClass}'>
      <div class='label-row'>
        <div class='label'>Function Output</div>
        <div class='actions'>
          ${tsInline}
          <button class='toggle' type='button' aria-expanded='${ariaExpanded}'>${toggleLabel}</button>
        </div>
      </div>
      <div class='collapsible-content'>
        <pre class='code'>${esc(body)}</pre>
      </div>
    </div>
    `;
  }

  function renderTokenUsage(entry, tsInline) {
    const info = (entry && entry.info) || {};
    const total = info.total_token_usage || {};
    const last = info.last_token_usage || {};
    const mcw = info.model_context_window;

    function itemRow(title, data) {
      const keys = [
        ["input_tokens", "Input"],
        ["cached_input_tokens", "Cached Input"],
        ["output_tokens", "Output"],
        ["reasoning_output_tokens", "Reasoning"],
        ["total_tokens", "Total"],
      ];
      const parts = [];
      for (const [key, label] of keys) {
        if (Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null && data[key] !== undefined) {
          parts.push(`<div class='kv'><span class='k'>${esc(label)}</span><span class='v'>${esc(String(data[key]))}</span></div>`);
        }
      }
      if (!parts.length) {
        return "";
      }
      return `<div class='usage-section'><div class='usage-title'>${esc(title)}</div><div class='kv-list'>${parts.join("")}</div></div>`;
    }

    const sections = [itemRow("Total", total), itemRow("Last Call", last)];
    if (mcw !== null && mcw !== undefined) {
      sections.push(`<div class='usage-section'><div class='usage-title'>Model Context</div><div class='kv-list'><div class='kv'><span class='k'>Window</span><span class='v'>${esc(String(mcw))}</span></div></div></div>`);
    }

    return `
    <div class='block usage'>
      <div class='label-row'>
        <div class='label'>Token Usage</div>
        <div class='actions'>${tsInline}</div>
      </div>
      <div class='usage-body'>
        ${sections.filter(Boolean).join("")}
      </div>
    </div>
    `;
  }

  function renderSessionHeader(meta, sourcePath, tsInline) {
    const parts = [];
    if (meta.id) {
      parts.push(`<div><b>Session:</b> ${esc(meta.id)}</div>`);
    }
    if (meta.timestamp) {
      parts.push(`<div><b>Started:</b> ${esc(meta.timestamp)}</div>`);
    }
    const git = meta.git || {};
    if (git.repository_url) {
      parts.push(`<div><b>Repo:</b> ${esc(git.repository_url)}</div>`);
    }
    if (git.branch) {
      parts.push(`<div><b>Branch:</b> ${esc(git.branch)}</div>`);
    }
    if (git.commit_hash) {
      parts.push(`<div><b>Commit:</b> <code>${esc(git.commit_hash)}</code></div>`);
    }
    if (!parts.length) {
      return "";
    }
    return `
    <div class='session'>
      <div class='header-row'>
        <div class='title'>Codex Session Log</div>
        ${tsInline}
      </div>
      <div class='subtitle'>${esc(sourcePath)}</div>
      ${parts.join("")}
    </div>
    `;
  }

  function renderToolbar(showTokenUsage, availableFilterClasses) {
    const chips = FILTER_OPTIONS
      .filter((option) => availableFilterClasses.has(option.cls))
      .map((option) => {
        const checked = option.cls === "usage" ? showTokenUsage : option.checked;
        const checkedAttr = checked ? " checked" : "";
        const chipClass = option.chipClass ? ` ${option.chipClass}` : "";
        return `<label class='filter-chip${chipClass}'><input type='checkbox' data-class='${option.cls}'${checkedAttr} /> ${option.label}</label>`;
      })
      .join("");
    const filtersHtml = chips ? `<div class='filters' title='Show/Hide blocks'>${chips}</div>` : "";
    return `
    <div class='status-bar'>
      <div class='status-bar-inner'>
        <div class='status-actions'>
          <a href="#" id="collapse-all" class="status-link">Collapse All</a>
          <a href="#" id="expand-all" class="status-link">Expand All</a>
        </div>
        ${filtersHtml}
      </div>
    </div>
    `;
  }

  function readTokenMetrics(entry) {
    const info = (entry && entry.info) || {};
    const last = info.last_token_usage || {};
    const total = info.total_token_usage || {};
    const inputTokens = Number(last.input_tokens);
    const outputTokens = Number(last.output_tokens);
    if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
      return null;
    }
    const turnPriceUsd = (inputTokens * TOKEN_PRICE_INPUT_PER_TOKEN) + (outputTokens * TOKEN_PRICE_OUTPUT_PER_TOKEN);

    const totalInputTokens = Number(total.input_tokens);
    const totalOutputTokens = Number(total.output_tokens);
    const cumulativePriceUsd =
      Number.isFinite(totalInputTokens) && Number.isFinite(totalOutputTokens)
        ? (totalInputTokens * TOKEN_PRICE_INPUT_PER_TOKEN) + (totalOutputTokens * TOKEN_PRICE_OUTPUT_PER_TOKEN)
        : null;

    return { inputTokens, outputTokens, turnPriceUsd, cumulativePriceUsd };
  }

  // Creates two SVG charts: tokens (left) and price (right), both over conversation progress.
  function createTokenUsageSvg(points, showCumulativeCostOverlay, userInterventionProgress) {
    if (!Array.isArray(points) || points.length < 2) {
      return "";
    }

    const width = 440;
    const height = 220;
    const m = { top: 18, right: 16, bottom: 42, left: 58 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    if (plotW <= 0 || plotH <= 0) {
      return "";
    }

    const tokenMinY = 0;
    const tokenMaxY = Math.max(
      1,
      ...points.map((p) => Math.max(p.inputTokens, p.outputTokens)),
    );
    const tokenSpan = Math.max(1, tokenMaxY - tokenMinY);

    const hasCumulativeData = points.some((p) => Number.isFinite(p.cumulativePriceUsd));
    const priceMinY = 0;
    const turnPriceMaxY = Math.max(0.0001, ...points.map((p) => p.turnPriceUsd));
    const turnPriceSpan = Math.max(0.0001, turnPriceMaxY - priceMinY);
    const combinedPriceMaxY = hasCumulativeData
      ? Math.max(
        turnPriceMaxY,
        ...points
          .map((p) => p.cumulativePriceUsd)
          .filter((value) => Number.isFinite(value)),
      )
      : turnPriceMaxY;
    const combinedPriceSpan = Math.max(0.0001, combinedPriceMaxY - priceMinY);
    const interventionProgressValues = Array.isArray(userInterventionProgress)
      ? userInterventionProgress
      : [];
    const minProgress = Math.min(
      ...points.map((p) => p.progress),
      ...(interventionProgressValues.length ? interventionProgressValues : [points[0].progress]),
    );
    const maxProgress = Math.max(
      ...points.map((p) => p.progress),
      ...(interventionProgressValues.length ? interventionProgressValues : [points[points.length - 1].progress]),
    );
    const progressSpan = Math.max(1, maxProgress - minProgress);

    const xPx = (progress) => m.left + ((progress - minProgress) / progressSpan) * plotW;
    const yTokenPx = (value) => m.top + (1 - (value - tokenMinY) / tokenSpan) * plotH;
    const yPriceTurnPx = (value) => m.top + (1 - (value - priceMinY) / turnPriceSpan) * plotH;
    const yPriceCombinedPx = (value) => m.top + (1 - (value - priceMinY) / combinedPriceSpan) * plotH;

    const buildPath = (valueGetter, yPx) => points
      .map((p, idx) => `${idx === 0 ? "M" : "L"}${xPx(p.progress).toFixed(2)} ${yPx(valueGetter(p)).toFixed(2)}`)
      .join(" ");

    const inputPath = buildPath((p) => p.inputTokens, yTokenPx);
    const outputPath = buildPath((p) => p.outputTokens, yTokenPx);
    const pricePathTurnScale = buildPath((p) => p.turnPriceUsd, yPriceTurnPx);
    const pricePathCombinedScale = buildPath((p) => p.turnPriceUsd, yPriceCombinedPx);
    const cumulativePricePathCombinedScale = hasCumulativeData
      ? buildPath(
        (p) => (Number.isFinite(p.cumulativePriceUsd) ? p.cumulativePriceUsd : p.turnPriceUsd),
        yPriceCombinedPx,
      )
      : "";

    const firstLabel = prettyTimestamp(points[0].ts) || "Start";
    const lastLabel = prettyTimestamp(points[points.length - 1].ts) || "End";
    const yTicks = 4;

    const renderGridAndTicks = (maxY, span, isCurrency = false) => {
      const parts = [];
      for (let i = 0; i <= yTicks; i += 1) {
        const y = m.top + (i / yTicks) * plotH;
        const tickValue = maxY - (i / yTicks) * span;
        const tickText = isCurrency
          ? (tickValue >= 1 ? `$${tickValue.toFixed(2)}` : `$${tickValue.toFixed(4)}`)
          : Math.round(tickValue).toLocaleString();
        parts.push(`<line x1="${m.left}" y1="${y.toFixed(2)}" x2="${(width - m.right).toFixed(2)}" y2="${y.toFixed(2)}" class="token-chart-grid"/>`);
        parts.push(`<text x="${(m.left - 10).toFixed(2)}" y="${(y + 4).toFixed(2)}" text-anchor="end" class="token-chart-tick">${esc(tickText)}</text>`);
      }
      return parts.join("");
    };

    const tokenGrid = renderGridAndTicks(tokenMaxY, tokenSpan, false);
    const turnPriceGrid = renderGridAndTicks(turnPriceMaxY, turnPriceSpan, true);
    const combinedPriceGrid = renderGridAndTicks(combinedPriceMaxY, combinedPriceSpan, true);
    const interventionLines = [...new Set(interventionProgressValues)]
      .map((progress) => {
        const x = xPx(progress);
        if (x < m.left || x > (width - m.right)) {
          return "";
        }
        return `<line x1="${x.toFixed(2)}" y1="${m.top}" x2="${x.toFixed(2)}" y2="${(height - m.bottom).toFixed(2)}" class="token-chart-intervention"/>`;
      })
      .filter(Boolean)
      .join("");

    const renderPriceSvg = (gridHtml, turnPath, includeCumulative, ariaLabel, modeClass) => `
          <svg class="token-chart-svg ${modeClass}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(ariaLabel)}">
            <rect x="0" y="0" width="${width}" height="${height}" class="token-chart-bg"/>
            ${gridHtml}
            ${interventionLines}
            <line x1="${m.left}" y1="${(height - m.bottom).toFixed(2)}" x2="${(width - m.right).toFixed(2)}" y2="${(height - m.bottom).toFixed(2)}" class="token-chart-axis"/>
            <line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${(height - m.bottom).toFixed(2)}" class="token-chart-axis"/>
            ${includeCumulative ? `<path d="${cumulativePricePathCombinedScale}" class="token-chart-line token-chart-line-price-cumulative"/>` : ""}
            <path d="${turnPath}" class="token-chart-line token-chart-line-price"/>
            <text x="${(m.left + plotW / 2).toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" class="token-chart-label">Conversation progress</text>
            <text x="16" y="${(m.top + plotH / 2).toFixed(2)}" text-anchor="middle" transform="rotate(-90 16 ${(m.top + plotH / 2).toFixed(2)})" class="token-chart-label">USD</text>
            <text x="${m.left}" y="${(height - m.bottom + 18).toFixed(2)}" text-anchor="start" class="token-chart-tick">${esc(firstLabel)}</text>
            <text x="${(width - m.right).toFixed(2)}" y="${(height - m.bottom + 18).toFixed(2)}" text-anchor="end" class="token-chart-tick">${esc(lastLabel)}</text>
          </svg>
    `;

    return `
    <section class="token-chart-panel${showCumulativeCostOverlay ? "" : " hide-cumulative-cost-overlay"}">
      <div class="token-chart-title">Token Usage Progress</div>
      <div class="token-chart-legend">
        <span class="token-chart-key token-chart-key-input">Input tokens</span>
        <span class="token-chart-key token-chart-key-output">Output tokens</span>
        <span class="token-chart-key token-chart-key-price">Turn cost (USD)</span>
        ${hasCumulativeData ? `<label class="token-chart-key token-chart-key-price-cumulative token-chart-key-toggle"><input type="checkbox" data-role="toggle-cumulative-cost"${showCumulativeCostOverlay ? " checked" : ""} /> Cumulative cost (USD)</label>` : ""}
        <span class="token-chart-rates">Rates: input $${TOKEN_PRICE_INPUT_PER_1M.toFixed(2)}/1M, output $${TOKEN_PRICE_OUTPUT_PER_1M.toFixed(2)}/1M</span>
      </div>
      <div class="token-chart-grid-layout">
        <div class="token-chart-card">
          <div class="token-chart-card-title">Tokens (Left)</div>
          <svg class="token-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Input and output token counts over conversation progress">
            <rect x="0" y="0" width="${width}" height="${height}" class="token-chart-bg"/>
            ${tokenGrid}
            ${interventionLines}
            <line x1="${m.left}" y1="${(height - m.bottom).toFixed(2)}" x2="${(width - m.right).toFixed(2)}" y2="${(height - m.bottom).toFixed(2)}" class="token-chart-axis"/>
            <line x1="${m.left}" y1="${m.top}" x2="${m.left}" y2="${(height - m.bottom).toFixed(2)}" class="token-chart-axis"/>
            <path d="${inputPath}" class="token-chart-line token-chart-line-input"/>
            <path d="${outputPath}" class="token-chart-line token-chart-line-output"/>
            <text x="${(m.left + plotW / 2).toFixed(2)}" y="${(height - 10).toFixed(2)}" text-anchor="middle" class="token-chart-label">Conversation progress</text>
            <text x="16" y="${(m.top + plotH / 2).toFixed(2)}" text-anchor="middle" transform="rotate(-90 16 ${(m.top + plotH / 2).toFixed(2)})" class="token-chart-label">Tokens</text>
            <text x="${m.left}" y="${(height - m.bottom + 18).toFixed(2)}" text-anchor="start" class="token-chart-tick">${esc(firstLabel)}</text>
            <text x="${(width - m.right).toFixed(2)}" y="${(height - m.bottom + 18).toFixed(2)}" text-anchor="end" class="token-chart-tick">${esc(lastLabel)}</text>
          </svg>
        </div>
        <div class="token-chart-card">
          <div class="token-chart-card-title">Price (Right)</div>
          ${renderPriceSvg(turnPriceGrid, pricePathTurnScale, false, "Per-turn token price over conversation progress", "price-mode-turn")}
          ${renderPriceSvg(combinedPriceGrid, pricePathCombinedScale, hasCumulativeData, "Per-turn and cumulative token price over conversation progress", "price-mode-combined")}
        </div>
      </div>
    </section>
    `;
  }

  function renderJsonl(jsonlText, sourcePath, options) {
    const blocks = [];
    const availableFilterClasses = new Set();
    const tokenSeries = [];
    const userInterventionProgress = [];
    let sessionHeaderDone = false;
    let wrappedMode = null;
    const lines = jsonlText.split(/\r?\n/);
    let progress = 0;

    for (const lineRaw of lines) {
      const line = lineRaw.trim();
      if (!line) {
        continue;
      }

      let rawObj;
      try {
        rawObj = JSON.parse(line);
      } catch {
        blocks.push(
          `<div class='block func-output'><div class='label'>Unparsed Line</div><pre class='code'>${esc(line)}</pre></div>`,
        );
        continue;
      }

      if (wrappedMode === null) {
        wrappedMode = Boolean(rawObj && typeof rawObj === "object" && Object.prototype.hasOwnProperty.call(rawObj, "payload") && Object.prototype.hasOwnProperty.call(rawObj, "timestamp"));
      }

      let entry;
      let outerType = null;
      let tsInline = "";
      let tsRaw = "";
      const currentProgress = progress;
      progress += 1;
      if (wrappedMode) {
        outerType = rawObj.type || null;
        entry = rawObj.payload || {};
        tsInline = buildTimestampInline(rawObj.timestamp);
        tsRaw = rawObj.timestamp || "";
      } else {
        entry = rawObj;
        tsRaw = entry.timestamp || "";
      }

      if (!sessionHeaderDone && (entry.timestamp || entry.git || entry.instructions)) {
        blocks.push(renderSessionHeader(entry, sourcePath, tsInline));
        sessionHeaderDone = true;
        continue;
      }

      const typ = entry.type;
      if (typ === "reasoning") {
        availableFilterClasses.add("reasoning");
        blocks.push(renderReasoning(entry, tsInline));
      } else if (typ === "message") {
        if (entry.role === "user") {
          userInterventionProgress.push(currentProgress);
        }
        availableFilterClasses.add(entry.role === "user" ? "user" : "assistant");
        blocks.push(renderMessage(entry, tsInline));
      } else if (typ === "function_call") {
        if (isPlanUpdateFunctionCall(entry)) {
          availableFilterClasses.add("plan");
        } else {
          availableFilterClasses.add("func-call");
        }
        blocks.push(renderFunctionCall(entry, tsInline));
      } else if (typ === "function_call_output") {
        availableFilterClasses.add("func-output");
        blocks.push(renderFunctionOutput(entry, tsInline, options));
      } else if (typ === "user_message") {
        userInterventionProgress.push(currentProgress);
        availableFilterClasses.add("user");
        blocks.push(renderMessage({ role: "user", content: [{ type: "input_text", text: entry.message || "" }] }, tsInline));
      } else if (typ === "agent_message") {
        availableFilterClasses.add("assistant");
        blocks.push(renderMessage({ role: "assistant", content: [{ type: "output_text", text: entry.message || "" }] }, tsInline));
      } else if (typ === "agent_reasoning") {
        availableFilterClasses.add("reasoning");
        blocks.push(renderReasoning({ summary: [{ type: "summary_text", text: entry.text || "" }] }, tsInline));
      } else if (typ === "token_count") {
        availableFilterClasses.add("usage");
        const metrics = readTokenMetrics(entry);
        if (metrics !== null) {
          tokenSeries.push({ ts: tsRaw, progress: currentProgress, ...metrics });
        }
        blocks.push(renderTokenUsage(entry, tsInline));
      } else {
        availableFilterClasses.add("func-output");
        const eventLabel = typ || outerType || entry.record_type || "unknown";
        blocks.push(
          `<div class='block func-output'><div class='label'>Event: ${esc(String(eventLabel))}</div><pre class='code'>${esc(JSON.stringify(entry, null, 2))}</pre></div>`,
        );
      }
    }

    if (!blocks.length) {
      blocks.push("<div class='session'><div class='title'>No events rendered</div><div class='subtitle'>The input file did not include renderable lines.</div></div>");
    }

    const chartHtml = createTokenUsageSvg(
      tokenSeries,
      options.showCumulativeCostOverlay,
      userInterventionProgress,
    );
    return `${chartHtml}${renderToolbar(options.showTokenUsage, availableFilterClasses)}${blocks.filter(Boolean).join("")}`;
  }

  function setCollapsed(el, collapsed) {
    if (!el) {
      return;
    }
    if (collapsed) {
      el.classList.add("collapsed");
    } else {
      el.classList.remove("collapsed");
    }
    const btn = el.querySelector(".toggle");
    if (btn) {
      btn.setAttribute("aria-expanded", String(!collapsed));
      btn.textContent = collapsed ? "Expand" : "Collapse";
    }
  }

  function applyFilterState() {
    const checkboxes = document.querySelectorAll(".filters input[type='checkbox'][data-class]");
    for (const cb of checkboxes) {
      const cls = cb.getAttribute("data-class");
      if (!cls) {
        continue;
      }
      document.body.classList.toggle(`hide-${cls}`, !cb.checked);
    }
  }

  function saveFilterState() {
    const state = {};
    const checkboxes = document.querySelectorAll(".filters input[type='checkbox'][data-class]");
    for (const cb of checkboxes) {
      const cls = cb.getAttribute("data-class");
      if (!cls) {
        continue;
      }
      state[cls] = Boolean(cb.checked);
    }
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify(state));
    } catch {
      // ignore storage errors
    }
  }

  function loadFilterState(defaultUsageVisible) {
    let state = null;
    try {
      const raw = localStorage.getItem(FILTERS_KEY);
      if (raw) {
        state = JSON.parse(raw);
      }
    } catch {
      state = null;
    }

    const checkboxes = document.querySelectorAll(".filters input[type='checkbox'][data-class]");
    for (const cb of checkboxes) {
      const cls = cb.getAttribute("data-class");
      if (!cls) {
        continue;
      }
      if (cls === "usage") {
        cb.checked = Boolean(defaultUsageVisible);
      } else if (state && Object.prototype.hasOwnProperty.call(state, cls)) {
        cb.checked = Boolean(state[cls]);
      }
    }
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function highlightText(text, lang) {
    const language = (lang || "").toLowerCase();
    const escaped = escapeHtml(text);
    if (language === "diff") {
      const lines = escaped.split("\n");
      return lines
        .map((line) => {
          let cls = "tok-line";
          if (line.startsWith("+")) cls += " tok-add";
          else if (line.startsWith("-")) cls += " tok-del";
          else if (line.startsWith("@")) cls += " tok-meta";
          return `<span class='${cls}'>${line}</span>`;
        })
        .join("");
    }

    let out = escaped;
    out = out.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, (m) => `<span class='tok-str'>${m}</span>`);

    if (["python", "py", "bash", "sh", "shell"].includes(language)) {
      out = out.replace(/(^|\s)(#.*)$/gm, (_, p1, p2) => `${p1}<span class='tok-com'>${p2}</span>`);
    }
    if (language === "json") {
      out = out.replace(/\b(true|false|null)\b/g, "<span class='tok-kw'>$1</span>");
      out = out.replace(/\b-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, "<span class='tok-num'>$&</span>");
    }
    if (language === "python" || language === "py") {
      const kw = /\b(False|True|None|def|class|return|if|elif|else|for|while|try|except|finally|with|as|import|from|pass|break|continue|yield|lambda|global|nonlocal|assert|raise|in|is|and|or|not)\b/g;
      out = out.replace(kw, "<span class='tok-kw'>$1</span>");
    }
    if (["bash", "sh", "shell"].includes(language)) {
      out = out.replace(/(^|\s)(-[a-zA-Z][a-zA-Z0-9-]*)/g, "$1<span class='tok-kw'>$2</span>");
    }
    return out;
  }

  function highlightAll() {
    const nodes = document.querySelectorAll(".markdown pre code, pre.code > code[class*='language-']");
    for (const code of nodes) {
      const cls = code.className || "";
      const m = cls.match(/language-([a-z0-9]+)/i);
      const lang = m ? m[1].toLowerCase() : "";
      const txt = code.textContent || "";
      code.innerHTML = highlightText(txt, lang);
    }
  }

  function bindInteractions(defaultUsageVisible) {
    if (!interactionsBound) {
      document.addEventListener(
        "click",
        (ev) => {
          const target = ev.target;
          if (!target || !target.closest) {
            return;
          }

          const toggle = target.closest(".toggle");
          if (toggle) {
            ev.preventDefault();
            const box = toggle.closest(".collapsible");
            if (box) {
              setCollapsed(box, !box.classList.contains("collapsed"));
            }
            return;
          }

          const collapseAll = target.closest("#collapse-all");
          if (collapseAll) {
            ev.preventDefault();
            document.querySelectorAll(".collapsible").forEach((el) => setCollapsed(el, true));
            return;
          }

          const expandAll = target.closest("#expand-all");
          if (expandAll) {
            ev.preventDefault();
            document.querySelectorAll(".collapsible").forEach((el) => setCollapsed(el, false));
            return;
          }

          const copyBtn = target.closest(".copy");
          if (copyBtn) {
            ev.preventDefault();
            const box = copyBtn.closest(".apply-patch");
            if (!box) {
              return;
            }
            const b64 = box.getAttribute("data-raw-b64") || "";
            let raw = "";
            try {
              raw = base64ToUtf8(b64);
            } catch {
              return;
            }

            const setCopiedText = () => {
              const oldText = copyBtn.textContent;
              copyBtn.textContent = "Copied!";
              setTimeout(() => {
                copyBtn.textContent = oldText;
              }, 1200);
            };

            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(raw).then(setCopiedText).catch(() => {
                const ta = document.createElement("textarea");
                ta.value = raw;
                document.body.appendChild(ta);
                ta.select();
                try {
                  document.execCommand("copy");
                } catch {
                  // ignore
                }
                document.body.removeChild(ta);
                setCopiedText();
              });
            } else {
              const ta = document.createElement("textarea");
              ta.value = raw;
              document.body.appendChild(ta);
              ta.select();
              try {
                document.execCommand("copy");
              } catch {
                // ignore
              }
              document.body.removeChild(ta);
              setCopiedText();
            }
          }
        },
        false,
      );

      document.addEventListener("change", (ev) => {
        const cumulativeToggle = ev.target && ev.target.closest && ev.target.closest("input[data-role='toggle-cumulative-cost']");
        if (cumulativeToggle) {
          const panel = cumulativeToggle.closest(".token-chart-panel");
          if (panel) {
            panel.classList.toggle("hide-cumulative-cost-overlay", !cumulativeToggle.checked);
          }
          return;
        }

        const cb = ev.target && ev.target.closest && ev.target.closest(".filters input[type='checkbox'][data-class]");
        if (!cb) {
          return;
        }
        applyFilterState();
        saveFilterState();
      });

      interactionsBound = true;
    }

    loadFilterState(defaultUsageVisible);
    applyFilterState();
    highlightAll();
  }

  function toBoolean(value, fallback) {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
      if (normalized === "false" || normalized === "0" || normalized === "no") return false;
    }
    return fallback;
  }

  function toNumber(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return fallback;
  }

  function basename(path) {
    if (!path) {
      return "";
    }
    const clean = String(path).replace(/[?#].*$/, "");
    const parts = clean.split("/");
    return parts[parts.length - 1] || clean;
  }

  function defaultSourceFromCurrentPage() {
    const pageName = basename(window.location.pathname);
    if (!pageName) {
      return DEFAULT_VIEWER_OPTIONS.source;
    }
    if (/\.html?$/i.test(pageName)) {
      return pageName.replace(/\.html?$/i, ".jsonl");
    }
    return `${pageName}.jsonl`;
  }

  function showError(app, message, detail) {
    const detailHtml = detail ? `<pre class='code'>${esc(detail)}</pre>` : "";
    app.innerHTML = `
      <div class='session'>
        <div class='title'>Unable to render log</div>
        <div class='subtitle'>${esc(message)}</div>
        ${detailHtml}
      </div>
    `;
  }

  async function fetchText(url) {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
  }

  function normalizeSessionText(rawText) {
    const text = typeof rawText === "string" ? rawText : "";
    const trimmed = text.trim();
    if (!trimmed) {
      return text;
    }

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => JSON.stringify(item)).join("\n");
        }
        if (parsed && typeof parsed === "object") {
          return JSON.stringify(parsed);
        }
      } catch {
        // Keep original text when it is not valid JSON.
      }
    }
    return text;
  }

  async function init() {
    const app = document.getElementById("app");
    if (!app) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const metaSource = document.querySelector("meta[name='codex-log-source']");
    const sourceRef = String(
      params.get("source")
      || (metaSource && metaSource.getAttribute("content"))
      || defaultSourceFromCurrentPage(),
    ).trim();
    const titlePrefix = String(params.get("title") || DEFAULT_VIEWER_OPTIONS.title).trim() || DEFAULT_VIEWER_OPTIONS.title;
    const showTokenUsage = toBoolean(params.get("showTokenUsage"), DEFAULT_VIEWER_OPTIONS.showTokenUsage);
    const showCumulativeCostOverlay = toBoolean(
      params.get("showCumulativeCostOverlay"),
      DEFAULT_SHOW_CUMULATIVE_COST_OVERLAY,
    );
    const collapseOutputCharThreshold = Math.max(
      1,
      Math.floor(toNumber(params.get("collapseOutputCharThreshold"), DEFAULT_VIEWER_OPTIONS.collapseOutputCharThreshold)),
    );
    const collapseOutputLineThreshold = Math.max(
      1,
      Math.floor(toNumber(params.get("collapseOutputLineThreshold"), DEFAULT_VIEWER_OPTIONS.collapseOutputLineThreshold)),
    );

    let sourceUrl;
    try {
      sourceUrl = new URL(sourceRef, window.location.href).toString();
    } catch (e) {
      showError(app, "Invalid source URL.", String(e));
      return;
    }

    const inlineBase64El = document.getElementById("codex-log-inline-jsonl-b64");
    const inlineTextEl = document.getElementById("codex-log-inline-jsonl");

    try {
      let sourceText = "";
      try {
        sourceText = await fetchText(sourceUrl);
      } catch (fetchErr) {
        const inlineB64 = inlineBase64El && inlineBase64El.textContent ? inlineBase64El.textContent.trim() : "";
        const inlineText = inlineTextEl && inlineTextEl.textContent ? inlineTextEl.textContent : "";
        if (inlineB64) {
          sourceText = base64ToUtf8(inlineB64);
        } else if (inlineText) {
          sourceText = inlineText;
        } else {
          throw fetchErr;
        }
      }
      const jsonlText = normalizeSessionText(sourceText);

      const options = {
        collapseOutputCharThreshold,
        collapseOutputLineThreshold,
        showTokenUsage,
        showCumulativeCostOverlay,
      };
      app.innerHTML = renderJsonl(jsonlText, sourceRef, options);
      bindInteractions(showTokenUsage);

      const titleStem = basename(sourceRef) || "session";
      document.title = `${titlePrefix} - ${titleStem}`;
    } catch (e) {
      showError(
        app,
        `Failed to load source log (${sourceRef}). Serve this folder via HTTP and verify the source path.`,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
