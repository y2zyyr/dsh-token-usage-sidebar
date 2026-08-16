window.__ModuleLoader__.load({
	id: "dsh-token-usage-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // src/client/index.tsx
  var import_react2 = __require("react");
  var import_client = __require("react-dom/client");

  // src/client/settings.tsx
  var import_react = __require("react");
  var import_jsx_runtime = __require("react/jsx-runtime");
  async function fetchDetails(range, signal) {
    try {
      const res = await fetch("/token-usage/api/details", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ range }),
        signal,
        cache: "no-store"
      });
      if (!res.ok) return void 0;
      const json = await res.json();
      return json.ok === true && json.value ? json.value : void 0;
    } catch {
      return void 0;
    }
  }
  function fullTokens(n) {
    return Math.round(n).toLocaleString("en-US");
  }
  function Metric({ label, value, hint }) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-metric", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { title: fullTokens(value) + " tokens", children: formatTokens(value) }),
      hint && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: hint })
    ] });
  }
  function TokenUsageSettings({ t }) {
    const [range, setRange] = (0, import_react.useState)("7d");
    const [summary, setSummary] = (0, import_react.useState)();
    const [details, setDetails] = (0, import_react.useState)();
    const [sevenDay, setSevenDay] = (0, import_react.useState)();
    const [error, setError] = (0, import_react.useState)(false);
    const timer = (0, import_react.useRef)();
    const refresh = (0, import_react.useCallback)(async (selected) => {
      const work = [
        fetchSummary(),
        fetchDetails(selected),
        selected === "7d" ? void 0 : fetchDetails("7d")
      ];
      const [nextSummary, nextDetails, nextSeven] = await Promise.all([work[0], work[1], work[2] ?? Promise.resolve(void 0)]);
      if (nextSummary) setSummary(nextSummary);
      if (nextDetails) setDetails(nextDetails);
      if (nextSeven) setSevenDay(nextSeven);
      else if (selected === "7d" && nextDetails) setSevenDay(nextDetails);
      setError(!nextDetails);
    }, []);
    (0, import_react.useEffect)(() => {
      void refresh(range);
      timer.current = setInterval(() => {
        if (!document.hidden) void refresh(range);
      }, 3e4);
      return () => {
        if (timer.current) clearInterval(timer.current);
      };
    }, [range, refresh]);
    const overviewSeven = sevenDay?.totalTokens ?? 0;
    const c = details?.categories;
    const rangeLabel = range === "7d" && details?.rangeStartDate && details.rangeEndDate ? details.rangeStartDate + " \u2013 " + details.rangeEndDate : void 0;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("section", { className: "dtsu-settings", "data-dsh-token-usage-settings": "1", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-settings-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { children: t("title") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("subtitle") })
        ] }),
        rangeLabel && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-range-date", children: rangeLabel })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-overview", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("allTime"), value: summary?.lifetimeTotal ?? 0 }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("today"), value: summary?.todayTotal ?? 0 }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("yesterday"), value: summary?.yesterdayTotal ?? 0 }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("last7Days"), value: overviewSeven })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-section-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("details") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-range-switch", role: "tablist", "aria-label": t("details"), children: ["today", "yesterday", "7d", "all"].map((key) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": range === key,
            className: range === key ? "is-active" : "",
            onClick: () => setRange(key),
            children: t(key)
          },
          key
        )) })
      ] }),
      !details && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dtsu-loading", children: error ? t("unavailable") : t("loading") }),
      details && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-metrics-grid", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("total"), value: details.totalTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("input"), value: c.totalTokens === void 0 ? 0 : c.inputTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("output"), value: c.outputTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("cacheRead"), value: c.cacheReadTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("cacheWrite"), value: c.cacheWriteTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("reasoning"), value: c.reasoningTokens, hint: t("reasoningHint") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("calls"), value: c.callCount })
        ] }),
        details.unknownTokens > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dtsu-note", children: t("unknown").replace("{tokens}", fullTokens(details.unknownTokens)).replace("{calls}", String(details.unknownCallCount)) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dtsu-table-title", children: t("byModel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { className: "dtsu-table", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("provider") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("model") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("total") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("input") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("output") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("cacheRead") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("cacheWrite") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("reasoning") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("calls") })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: details.models.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { colSpan: 9, className: "dtsu-empty-row", children: t("noClassified") }) }) : details.models.map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: model.provider }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: model.model }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.totalTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.inputTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.outputTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.cacheReadTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.cacheWriteTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.reasoningTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: model.callCount })
          ] }, model.provider + model.model)) })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dtsu-table-title", children: t("sevenDayDaily") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { className: "dtsu-table dtsu-daily", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("date") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("total") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("input") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("output") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("cacheRead") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("cacheWrite") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("reasoning") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("calls") })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: (sevenDay?.daily ?? []).map((day) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: day.date }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.totalTokens + day.unknownTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.inputTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.outputTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.cacheReadTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.cacheWriteTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.reasoningTokens) }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: day.callCount })
          ] }, day.date)) })
        ] }) })
      ] })
    ] });
  }

  // src/client/index.tsx
  var import_jsx_runtime2 = __require("react/jsx-runtime");
  var inject = ["slots", "locale", "connection"];
  var SETTINGS_NS = "dsh-token-usage-sidebar";
  var settingsLocale = {
    en: {
      nav: "Token Usage",
      title: "Token Usage",
      subtitle: "Authoritative usage recorded by DeepSeek Harness.",
      allTime: "All time",
      today: "Today",
      yesterday: "Yesterday",
      last7Days: "Last 7 days",
      details: "Usage details",
      "7d": "7D",
      all: "All time",
      total: "Total",
      input: "Input",
      output: "Output",
      cacheRead: "Cache read",
      cacheWrite: "Cache write",
      reasoning: "Reasoning",
      reasoningHint: "included in output",
      calls: "Calls",
      byModel: "By provider and model",
      provider: "Provider",
      model: "Model",
      sevenDayDaily: "Last 7 local days",
      date: "Date",
      loading: "Loading token usage\u2026",
      unavailable: "Usage data is temporarily unavailable.",
      noClassified: "No classified usage in this range.",
      unknown: "{tokens} tokens across {calls} calls cannot be classified from older records. They remain included in Total."
    },
    zh: {
      nav: "Token \u7528\u91CF",
      title: "Token \u7528\u91CF",
      subtitle: "\u57FA\u4E8E DeepSeek Harness \u5DF2\u63D0\u4EA4\u6D88\u606F\u7684\u6743\u5A01\u8BA1\u6570\u3002",
      allTime: "\u5168\u90E8\u65F6\u95F4",
      today: "\u4ECA\u5929",
      yesterday: "\u6628\u5929",
      last7Days: "\u6700\u8FD1 7 \u5929",
      details: "\u7528\u91CF\u660E\u7EC6",
      "7d": "7 \u5929",
      all: "\u5168\u90E8\u65F6\u95F4",
      total: "\u603B\u8BA1",
      input: "\u8F93\u5165",
      output: "\u8F93\u51FA",
      cacheRead: "\u7F13\u5B58\u8BFB\u53D6",
      cacheWrite: "\u7F13\u5B58\u5199\u5165",
      reasoning: "\u63A8\u7406",
      reasoningHint: "\u5DF2\u5305\u542B\u5728\u8F93\u51FA\u4E2D",
      calls: "\u8C03\u7528\u6B21\u6570",
      byModel: "\u6309\u4F9B\u5E94\u5546\u548C\u6A21\u578B",
      provider: "\u4F9B\u5E94\u5546",
      model: "\u6A21\u578B",
      sevenDayDaily: "\u6700\u8FD1 7 \u4E2A\u672C\u5730\u81EA\u7136\u65E5",
      date: "\u65E5\u671F",
      loading: "\u6B63\u5728\u52A0\u8F7D Token \u7528\u91CF\u2026",
      unavailable: "Token \u7528\u91CF\u6682\u65F6\u4E0D\u53EF\u7528\u3002",
      noClassified: "\u8FD9\u4E2A\u8303\u56F4\u5185\u6CA1\u6709\u53EF\u5206\u7C7B\u7684\u7528\u91CF\u3002",
      unknown: "\u6709 {tokens} tokens\u3001{calls} \u6B21\u8C03\u7528\u65E0\u6CD5\u4ECE\u65E7\u8BB0\u5F55\u4E2D\u5206\u7C7B\uFF1B\u5B83\u4EEC\u4ECD\u8BA1\u5165\u603B\u8BA1\u3002"
    }
  };
  var SUMMARY_URL = "/token-usage/api/summary";
  async function fetchSummary(signal) {
    try {
      const res = await fetch(SUMMARY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal,
        cache: "no-store"
      });
      if (!res.ok) return void 0;
      const json = await res.json().catch(() => void 0);
      const value = json?.ok === true ? json.value : void 0;
      if (!value) return void 0;
      return {
        todayTotal: Number(value.todayTotal) || 0,
        yesterdayTotal: Number(value.yesterdayTotal) || 0,
        lifetimeTotal: Number(value.lifetimeTotal) || 0,
        todayDate: value.todayDate ?? "",
        recordCount: Number(value.recordCount) || 0,
        serverNow: value.serverNow ?? ""
      };
    } catch {
      return void 0;
    }
  }
  function formatTokens(n) {
    if (!Number.isFinite(n) || n < 0) return "0";
    if (n < 1e3) return String(Math.round(n));
    const units = [
      [1e9, "B"],
      [1e6, "M"],
      [1e3, "K"]
    ];
    for (const [div, suffix] of units) {
      if (n >= div) {
        const v = n / div;
        const rounded = v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100;
        return String(rounded) + suffix;
      }
    }
    return String(Math.round(n));
  }
  function TokenUsageSidebar(_props) {
    const [summary, setSummary] = (0, import_react2.useState)(void 0);
    const [connected, setConnected] = (0, import_react2.useState)(void 0);
    const timer = (0, import_react2.useRef)(void 0);
    const summaryRef = (0, import_react2.useRef)(void 0);
    summaryRef.current = summary;
    const refresh = (0, import_react2.useCallback)(async () => {
      const s = await fetchSummary();
      if (s) {
        setSummary(s);
        setConnected(true);
      } else {
        setConnected((prev) => prev === void 0 ? void 0 : true);
      }
    }, []);
    (0, import_react2.useEffect)(() => {
      void refresh();
      timer.current = setInterval(() => {
        void refresh();
      }, 4e3);
      return () => {
        if (timer.current !== void 0) clearInterval(timer.current);
      };
    }, [refresh]);
    (0, import_react2.useEffect)(() => {
      const onVis = () => {
        if (document.hidden) {
          if (timer.current !== void 0) {
            clearInterval(timer.current);
            timer.current = void 0;
          }
        } else if (timer.current === void 0) {
          void refresh();
          timer.current = setInterval(() => {
            void refresh();
          }, 4e3);
        }
      };
      document.addEventListener("visibilitychange", onVis);
      return () => document.removeEventListener("visibilitychange", onVis);
    }, [refresh]);
    (0, import_react2.useEffect)(() => {
      if (typeof document === "undefined") return;
      if (document.querySelector('style[data-dtsu = "1"]')) return;
      const tag = document.createElement("style");
      tag.dataset.dtsu = "1";
      tag.dataset.plugin = "dsh-token-usage-sidebar";
      tag.textContent = `.dtsu-w{display:flex;flex-direction:column;gap:2px;margin:0 2px 8px;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:10px;background:var(--dsw-alias-fill-l2,transparent);font-size:12px;line-height:1.35;color:var(--dsw-alias-label-secondary);user-select:none;flex:none;width:auto}
html[data-dsh-desktop=true] .dtsu-w{border-color:transparent}
.dtsu-t{font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,inherit);margin-bottom:2px}
.dtsu-r{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.dtsu-k{color:inherit}
.dtsu-v{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-primary)}
.dtsu-empty{opacity:.45}
.dtsu-settings{width:100%;padding:4px 0 18px;color:var(--dsw-alias-label-primary,#eee);font-size:13px}.dtsu-settings h2,.dtsu-settings h3{margin:0;font-weight:600}.dtsu-settings h2{font-size:16px}.dtsu-settings h3{font-size:14px}.dtsu-settings-head,.dtsu-section-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}.dtsu-settings-head p{margin:5px 0 0;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-range-date{color:var(--dsw-alias-label-tertiary,#888);font-variant-numeric:tabular-nums;white-space:nowrap}.dtsu-overview,.dtsu-metrics-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-bottom:22px}.dtsu-metrics-grid{grid-template-columns:repeat(4,minmax(0,1fr));margin-top:12px}.dtsu-metric{min-height:66px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:10px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.06));display:flex;flex-direction:column;gap:5px}.dtsu-metric span,.dtsu-metric small{color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dtsu-metric small{font-size:10px}.dtsu-metric strong{font-size:18px;font-variant-numeric:tabular-nums}.dtsu-range-switch{display:flex;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:8px;padding:2px;gap:2px}.dtsu-range-switch button{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#aaa);padding:5px 9px;border-radius:6px;font:inherit;cursor:pointer}.dtsu-range-switch button.is-active{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.2));color:var(--dsw-alias-label-primary,#fff)}.dtsu-table-title{margin:24px 0 10px}.dtsu-table-wrap{overflow:auto;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:9px}.dtsu-table{border-collapse:collapse;width:100%;min-width:760px;font-variant-numeric:tabular-nums}.dtsu-table th,.dtsu-table td{padding:9px 10px;text-align:right;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14));white-space:nowrap}.dtsu-table th{color:var(--dsw-alias-label-secondary,#aaa);font-weight:500;font-size:11px}.dtsu-table th:first-child,.dtsu-table td:first-child,.dtsu-table th:nth-child(2),.dtsu-table td:nth-child(2){text-align:left}.dtsu-table tr:last-child td{border-bottom:0}.dtsu-note,.dtsu-loading,.dtsu-empty-row{color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-note{margin:0 0 4px;padding:9px 10px;border-radius:8px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.06))}.dtsu-empty-row{text-align:center!important;padding:20px!important}@media(max-width:760px){.dtsu-overview,.dtsu-metrics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dtsu-section-head{flex-direction:column}.dtsu-range-date{display:none}}
`;
      document.head.appendChild(tag);
    }, []);
    const today = summary ? formatTokens(summary.todayTotal) : "\u2013";
    const yesterday = summary ? formatTokens(summary.yesterdayTotal) : "\u2013";
    const total = summary ? formatTokens(summary.lifetimeTotal) : "\u2013";
    const ready = summary !== void 0;
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dtsu-w" + (ready ? "" : " dtsu-empty"), "data-dsh-token-usage-sidebar": "1", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: "dtsu-t", children: "Token Usage" }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dtsu-r", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dtsu-k", children: "Today" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dtsu-v", title: summary ? summary.todayTotal.toLocaleString("en-US") + " tokens" : void 0, children: today })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dtsu-r", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dtsu-k", children: "Yesterday" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dtsu-v", title: summary ? summary.yesterdayTotal.toLocaleString("en-US") + " tokens" : void 0, children: yesterday })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "dtsu-r", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dtsu-k", children: "Total" }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "dtsu-v", title: summary ? summary.lifetimeTotal.toLocaleString("en-US") + " tokens" : void 0, children: total })
      ] })
    ] });
  }
  function findNewSessionButton() {
    const buttons = Array.from(document.querySelectorAll("button"));
    return buttons.find((button) => String(button.className).includes("newSession")) ?? buttons.find((button) => button.hasAttribute("aria-label") && button.querySelector("span") !== null);
  }
  function mountLegacySidebarFallback() {
    if (typeof document === "undefined" || !document.body) return () => {
    };
    let mount;
    let root;
    let resize;
    const disposeMount = () => {
      resize?.disconnect();
      resize = void 0;
      root?.unmount();
      root = void 0;
      mount?.remove();
      mount = void 0;
    };
    const attach = () => {
      const target = findNewSessionButton();
      if (!target || !target.parentElement) return;
      if (mount?.parentElement === target.parentElement && mount.nextElementSibling === target) {
        mount.style.display = target.getBoundingClientRect().width < 100 ? "none" : "";
        return;
      }
      disposeMount();
      mount = document.createElement("div");
      mount.dataset.dshTokenUsageSidebarFallback = "1";
      target.parentElement.insertBefore(mount, target);
      root = (0, import_client.createRoot)(mount);
      root.render(/* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TokenUsageSidebar, {}));
      const updateCollapsedVisibility = () => {
        if (mount) mount.style.display = target.getBoundingClientRect().width < 100 ? "none" : "";
      };
      resize = new ResizeObserver(updateCollapsedVisibility);
      resize.observe(target);
      updateCollapsedVisibility();
    };
    const observer = new MutationObserver(attach);
    observer.observe(document.body, { childList: true, subtree: true });
    attach();
    return () => {
      observer.disconnect();
      disposeMount();
    };
  }
  function apply(ctx) {
    ctx.effect(() => ctx.locale.register(SETTINGS_NS, settingsLocale), "dsh-token-usage-sidebar: locale");
    const t = ctx.locale.bind(SETTINGS_NS);
    ctx.effect(() => {
      let slotMounted = false;
      let fallbackDispose;
      const fallbackTimer = window.setTimeout(() => {
        if (!slotMounted) fallbackDispose = mountLegacySidebarFallback();
      }, 400);
      const slotDispose = ctx.slots.inject("sidebar.leading", () => {
        slotMounted = true;
        window.clearTimeout(fallbackTimer);
        fallbackDispose?.();
        fallbackDispose = void 0;
        return ctx.slots.register(
          {
            name: "sidebar.leading",
            registrant: "dsh-token-usage-sidebar",
            inject: () => ({})
          },
          TokenUsageSidebar
        );
      });
      return () => {
        window.clearTimeout(fallbackTimer);
        fallbackDispose?.();
        slotDispose?.();
      };
    }, "dsh-token-usage-sidebar: sidebar placement");
    ctx.slots.inject("settings.section", () => ctx.slots.register(
      {
        name: "settings.section",
        id: "token-usage",
        order: 25,
        label: () => t("nav"),
        locale: SETTINGS_NS,
        inject: () => ({ t })
      },
      () => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(TokenUsageSettings, { t })
    ));
  }

  // src/client/_entry.js
  self.__dsh_token_usage_sidebar_entry__ = { apply, inject };
})();

		var entry = self.__dsh_token_usage_sidebar_entry__;
		module.exports.apply = entry && entry.apply;
		module.exports.inject = entry && entry.inject;
		return module.exports;
	}
});
