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
  var import_react = __require("react");
  var import_jsx_runtime = __require("react/jsx-runtime");
  var inject = ["slots", "locale", "connection"];
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
    const [summary, setSummary] = (0, import_react.useState)(void 0);
    const [connected, setConnected] = (0, import_react.useState)(void 0);
    const timer = (0, import_react.useRef)(void 0);
    const summaryRef = (0, import_react.useRef)(void 0);
    summaryRef.current = summary;
    const refresh = (0, import_react.useCallback)(async () => {
      const s = await fetchSummary();
      if (s) {
        setSummary(s);
        setConnected(true);
      } else {
        setConnected((prev) => prev === void 0 ? void 0 : true);
      }
    }, []);
    (0, import_react.useEffect)(() => {
      void refresh();
      timer.current = setInterval(() => {
        void refresh();
      }, 4e3);
      return () => {
        if (timer.current !== void 0) clearInterval(timer.current);
      };
    }, [refresh]);
    (0, import_react.useEffect)(() => {
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
    (0, import_react.useEffect)(() => {
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
`;
      document.head.appendChild(tag);
    }, []);
    const today = summary ? formatTokens(summary.todayTotal) : "\u2013";
    const yesterday = summary ? formatTokens(summary.yesterdayTotal) : "\u2013";
    const total = summary ? formatTokens(summary.lifetimeTotal) : "\u2013";
    const ready = summary !== void 0;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-w" + (ready ? "" : " dtsu-empty"), "data-dsh-token-usage-sidebar": "1", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-t", children: "Token Usage" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-r", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-k", children: "Today" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-v", title: summary ? summary.todayTotal.toLocaleString("en-US") + " tokens" : void 0, children: today })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-r", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-k", children: "Yesterday" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-v", title: summary ? summary.yesterdayTotal.toLocaleString("en-US") + " tokens" : void 0, children: yesterday })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-r", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-k", children: "Total" }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dtsu-v", title: summary ? summary.lifetimeTotal.toLocaleString("en-US") + " tokens" : void 0, children: total })
      ] })
    ] });
  }
  function apply(ctx) {
    ctx.effect(
      () => ctx.slots.inject(
        "sidebar.leading",
        () => ctx.slots.register(
          {
            name: "sidebar.leading",
            registrant: "dsh-token-usage-sidebar",
            inject: () => ({})
          },
          TokenUsageSidebar
        )
      ),
      "dsh-token-usage-sidebar: sidebar.leading slot registration"
    );
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
