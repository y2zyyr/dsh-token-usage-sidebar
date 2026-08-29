window.__ModuleLoader__.load({
	id: "@y2zyyr/dsh-token-usage-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
"use strict";
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
  var EMPTY_FILTERS = { provider: null, model: null };
  var EMPTY_FACETS = { providers: [], models: [], pairs: [], groups: [] };
  var EMPTY_METRICS = { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, callCount: 0 };
  var ALIAS_URL = "/token-usage/api/aliases";
  function normalizeDetails(value) {
    return {
      ...value,
      filters: value.filters ?? EMPTY_FILTERS,
      facets: value.facets ?? EMPTY_FACETS,
      excludedUnclassified: value.excludedUnclassified ?? { tokens: 0, calls: 0 }
    };
  }
  async function fetchDetails(range, filtersOrSignal, signal) {
    const isSignal = filtersOrSignal !== void 0 && typeof filtersOrSignal === "object" && "aborted" in filtersOrSignal;
    const filters = isSignal ? EMPTY_FILTERS : filtersOrSignal ?? EMPTY_FILTERS;
    const requestSignal = isSignal ? filtersOrSignal : signal;
    try {
      const res = await fetch("/token-usage/api/details", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ range, filters: { provider: filters.provider ?? null, model: filters.model ?? null } }),
        signal: requestSignal,
        cache: "no-store"
      });
      if (!res.ok) return void 0;
      const json = await res.json();
      return json.ok === true && json.value ? normalizeDetails(json.value) : void 0;
    } catch {
      return void 0;
    }
  }
  async function aliasRequest(body, signal) {
    const res = await fetch(ALIAS_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
      cache: "no-store"
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok !== true || !Array.isArray(json.value?.groups)) {
      throw new Error(json.error?.message ?? "provider-alias-request-failed");
    }
    return json.value.groups;
  }
  function fetchProviderAliases(signal) {
    return aliasRequest({ action: "list" }, signal);
  }
  function saveProviderAliasGroup(group, signal) {
    return aliasRequest({ action: "upsert", group }, signal);
  }
  function removeProviderAliasGroup(id, signal) {
    return aliasRequest({ action: "delete", id }, signal);
  }
  function fullTokens(n) {
    return Math.round(n).toLocaleString("en-US");
  }
  function calls(n) {
    return Math.round(n).toLocaleString("en-US");
  }
  function replace(template, values) {
    return Object.entries(values).reduce((text, [key, value]) => text.replaceAll("{" + key + "}", value), template);
  }
  function providerScopeKey(scope) {
    return scope ? JSON.stringify(scope) : "";
  }
  function providerScopeOf(value) {
    if (value.length === 0) return null;
    try {
      const parsed = JSON.parse(value);
      if (parsed.type === "raw" && typeof parsed.value === "string") return { type: "raw", value: parsed.value };
      if (parsed.type === "group" && typeof parsed.id === "string") return { type: "group", id: parsed.id };
    } catch {
    }
    return null;
  }
  function providerOptionLabel(option, t) {
    return option.type === "group" ? option.label + " \xB7 " + replace(t("includesRawNames"), { count: String(option.rawValues.length) }) : option.label;
  }
  function providerScopeLabel(scope, facets, t) {
    if (!scope) return "";
    const option = facets.providers.find((candidate) => candidate.type === scope.type && candidate.value === (scope.type === "raw" ? scope.value : scope.id));
    if (!option) return scope.type === "raw" ? scope.value : scope.id;
    return providerOptionLabel(option, t);
  }
  function Metric({ label, value, hint }) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-metric", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { title: fullTokens(value) + " tokens", children: formatTokens(value) }),
      hint && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: hint })
    ] });
  }
  function MetricLine({ label, value }) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-detail-line", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: label }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: value })
    ] });
  }
  function ScopeFilters({ details, filters, setFilters, t }) {
    const facets = details.facets ?? EMPTY_FACETS;
    const provider = filters.provider ?? null;
    const selectedProvider = providerScopeKey(provider);
    const modelOptions = (0, import_react.useMemo)(() => {
      const pairs = facets.pairs ?? [];
      if (!provider) return facets.models;
      const selected = facets.providers.find((option) => option.type === provider.type && option.value === (provider.type === "raw" ? provider.value : provider.id));
      const rawValues = selected?.rawValues ?? (provider.type === "raw" ? [provider.value] : []);
      return [...new Set(pairs.filter((pair) => rawValues.includes(pair.provider)).map((pair) => pair.model))].sort((a, b) => a.localeCompare(b));
    }, [facets, provider]);
    const active = provider !== null || (filters.model ?? null) !== null;
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-filter-bar", "aria-label": t("filterHelp"), children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dtsu-filter-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("providerFilter") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: selectedProvider, onChange: (event) => setFilters({ provider: providerScopeOf(event.target.value), model: null }), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: t("allProviders") }),
            facets.providers.some((option) => option.type === "group") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("optgroup", { label: t("providerGroups"), children: facets.providers.filter((option) => option.type === "group").map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: JSON.stringify({ type: "group", id: option.value }), children: providerOptionLabel(option, t) }, "group:" + option.value)) }),
            facets.providers.some((option) => option.type === "raw") && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("optgroup", { label: t("rawProviders"), children: facets.providers.filter((option) => option.type === "raw").map((option) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: JSON.stringify({ type: "raw", value: option.value }), children: providerOptionLabel(option, t) }, "raw:" + option.value)) })
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dtsu-filter-field", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("modelFilter") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("select", { value: filters.model ?? "", onChange: (event) => setFilters({ provider, model: event.target.value || null }), children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "", children: t("allModels") }),
            modelOptions.map((model) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: model, children: model }, model))
          ] })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dtsu-clear-filter", type: "button", disabled: !active, onClick: () => setFilters(EMPTY_FILTERS), children: t("clearFilters") })
      ] }),
      active && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("p", { className: "dtsu-filter-scope", children: [
        t("currentScope"),
        ": ",
        providerScopeLabel(provider, facets, t),
        provider && filters.model ? " \xB7 " : "",
        filters.model ?? ""
      ] })
    ] });
  }
  function AliasManager({ groups, setGroups, onChanged, t }) {
    const [open, setOpen] = (0, import_react.useState)(false);
    const [editorOpen, setEditorOpen] = (0, import_react.useState)(false);
    const [editingId, setEditingId] = (0, import_react.useState)();
    const [label, setLabel] = (0, import_react.useState)("");
    const [rawValues, setRawValues] = (0, import_react.useState)("");
    const [busy, setBusy] = (0, import_react.useState)(false);
    const [error, setError] = (0, import_react.useState)();
    const reset = () => {
      setEditingId(void 0);
      setLabel("");
      setRawValues("");
      setError(void 0);
      setEditorOpen(false);
    };
    const edit = (group) => {
      setEditingId(group.id);
      setLabel(group.label);
      setRawValues(group.rawValues.join("\n"));
      setError(void 0);
      setEditorOpen(true);
      setOpen(true);
    };
    const submit = async () => {
      const values = Array.from(new Set(rawValues.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0)));
      setBusy(true);
      setError(void 0);
      try {
        const next = await saveProviderAliasGroup({ id: editingId, label, rawValues: values });
        setGroups(next);
        reset();
        onChanged();
      } catch (cause) {
        setError(String(cause?.message ?? cause));
      } finally {
        setBusy(false);
      }
    };
    const remove = async (group) => {
      if (!window.confirm(t("confirmDeleteAlias").replace("{label}", group.label))) return;
      setBusy(true);
      setError(void 0);
      try {
        setGroups(await removeProviderAliasGroup(group.id));
        reset();
        onChanged(group.id);
      } catch (cause) {
        setError(String(cause?.message ?? cause));
      } finally {
        setBusy(false);
      }
    };
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-manager", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-manager-head", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { children: t("providerAliases") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("filterHelp") })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-secondary-button", onClick: () => {
          setOpen(!open);
          if (open) reset();
        }, children: open ? t("hideAliases") : t("manageAliases") })
      ] }),
      open && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-panel", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-list", children: [
          groups.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dtsu-muted", children: t("noAliasGroups") }),
          groups.map((group) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-row", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: group.label }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { children: group.rawValues.join(" \xB7 ") })
            ] }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-actions", children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-secondary-button", disabled: busy, onClick: () => edit(group), children: t("editAlias") }),
              /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-danger-button", disabled: busy, onClick: () => void remove(group), children: t("deleteAlias") })
            ] })
          ] }, group.id))
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-secondary-button", disabled: busy, onClick: () => {
          reset();
          setEditorOpen(true);
          setOpen(true);
        }, children: t("addAlias") }),
        editorOpen && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-alias-editor", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("aliasLabel") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("input", { value: label, onChange: (event) => setLabel(event.target.value), maxLength: 200 })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: t("aliasValues") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("textarea", { value: rawValues, onChange: (event) => setRawValues(event.target.value), rows: 4, placeholder: "provider-a\\nprovider-b\\nprovider-proxy" })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("small", { className: "dtsu-muted", children: t("aliasValuesHint") }),
          error && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dtsu-error", children: error }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-form-actions", children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-primary-button", disabled: busy, onClick: () => void submit(), children: t("save") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-secondary-button", disabled: busy, onClick: reset, children: t("cancel") })
          ] })
        ] })
      ] })
    ] });
  }
  function DetailMetrics({ model, t }) {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-expanded-content", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-detail-grid", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("input"), value: formatTokens(model.inputTokens) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("output"), value: formatTokens(model.outputTokens) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("cacheRead"), value: formatTokens(model.cacheReadTokens) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("cacheWrite"), value: formatTokens(model.cacheWriteTokens) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("reasoning"), value: formatTokens(model.reasoningTokens) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("calls"), value: calls(model.callCount) })
      ] }),
      model.rawProviders && model.rawProviders.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-raw-breakdown", children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("strong", { children: t("rawBreakdown") }),
        model.rawProviders.map((raw) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: raw.provider, value: formatTokens(raw.totalTokens) + " \xB7 " + calls(raw.callCount) }, raw.provider))
      ] })
    ] });
  }
  var SETTINGS_STYLE_ID = "dsh-token-usage-sidebar/settings.css";
  function TokenUsageSettings({ t }) {
    const [range, setRange] = (0, import_react.useState)("7d");
    const [summary, setSummary] = (0, import_react.useState)();
    const [details, setDetails] = (0, import_react.useState)();
    const [sevenDay, setSevenDay] = (0, import_react.useState)();
    const [groups, setGroups] = (0, import_react.useState)([]);
    const [filters, setFilters] = (0, import_react.useState)(EMPTY_FILTERS);
    const [error, setError] = (0, import_react.useState)(false);
    const [aliasVersion, setAliasVersion] = (0, import_react.useState)(0);
    const [expandedModel, setExpandedModel] = (0, import_react.useState)();
    const [expandedDay, setExpandedDay] = (0, import_react.useState)();
    const timer = (0, import_react.useRef)(void 0);
    const request = (0, import_react.useRef)(void 0);
    (0, import_react.useEffect)(() => {
      if (typeof document === "undefined" || document.getElementById(SETTINGS_STYLE_ID)) return;
      const tag = document.createElement("style");
      tag.id = SETTINGS_STYLE_ID;
      tag.textContent = `.dtsu-filter-bar{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:10px;align-items:end;margin:0 0 8px}.dtsu-filter-field{display:flex;flex-direction:column;gap:5px;min-width:0}.dtsu-filter-field>span,.dtsu-alias-editor label>span{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-filter-field select,.dtsu-alias-editor input,.dtsu-alias-editor textarea{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#eee);font:inherit;padding:7px 8px}.dtsu-filter-field select{min-width:0}.dtsu-clear-filter,.dtsu-secondary-button,.dtsu-primary-button,.dtsu-danger-button{border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));border-radius:7px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary,#eee);font:inherit;padding:7px 10px;cursor:pointer;white-space:nowrap}.dtsu-clear-filter:disabled,.dtsu-secondary-button:disabled,.dtsu-primary-button:disabled,.dtsu-danger-button:disabled{opacity:.45;cursor:default}.dtsu-primary-button{background:var(--dsw-alias-fill-l3,rgba(127,127,127,.22))}.dtsu-danger-button{color:#ff9b9b}.dtsu-filter-scope{margin:0 0 12px;color:var(--dsw-alias-label-secondary,#aaa);font-size:12px}.dtsu-alias-manager{margin:0 0 14px;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:9px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.04))}.dtsu-alias-manager-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.dtsu-alias-manager-head h3{margin:0}.dtsu-alias-manager-head p{margin:4px 0 0;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-alias-panel{display:flex;flex-direction:column;gap:10px;margin-top:12px}.dtsu-alias-list{display:flex;flex-direction:column;gap:6px}.dtsu-alias-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px;border-radius:7px;background:var(--dsw-alias-fill-l3,rgba(127,127,127,.08))}.dtsu-alias-row>div:first-child{min-width:0}.dtsu-alias-row strong,.dtsu-alias-row small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dtsu-alias-row small{margin-top:3px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-alias-actions,.dtsu-form-actions{display:flex;gap:6px;flex-wrap:wrap}.dtsu-alias-editor{display:flex;flex-direction:column;gap:8px;padding-top:4px}.dtsu-alias-editor label{display:flex;flex-direction:column;gap:5px}.dtsu-alias-editor textarea{resize:vertical}.dtsu-muted{margin:0;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-error{margin:0;color:#ff9b9b;font-size:12px}.dtsu-compact-table{min-width:0}.dtsu-compact-table th,.dtsu-compact-table td{padding:8px 9px}.dtsu-compact-table th:nth-child(1){width:24%}.dtsu-compact-table th:nth-child(2){width:31%}.dtsu-compact-table td:nth-child(1),.dtsu-compact-table td:nth-child(2){max-width:0;overflow:hidden;text-overflow:ellipsis}.dtsu-name-button,.dtsu-model-button,.dtsu-expand-button{border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;padding:0;text-align:left}.dtsu-name-button:hover,.dtsu-model-button:hover{text-decoration:underline}.dtsu-expand-button{color:var(--dsw-alias-label-secondary,#aaa);font-size:16px;line-height:1}.dtsu-action-cell{text-align:center!important;width:34px}.dtsu-expanded-row td{padding:0 10px 10px;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.04))}.dtsu-expanded-content{display:flex;flex-direction:column;gap:9px;padding-top:8px}.dtsu-detail-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px 16px}.dtsu-detail-line{display:flex;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-secondary,#aaa);font-size:11px}.dtsu-detail-line strong{color:var(--dsw-alias-label-primary,#eee);font-weight:500;font-variant-numeric:tabular-nums}.dtsu-raw-breakdown{display:flex;flex-direction:column;gap:5px;padding-top:7px;border-top:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.14))}.dtsu-raw-breakdown>strong{font-size:11px;color:var(--dsw-alias-label-secondary,#aaa)}.dtsu-daily-compact{min-width:0}.dtsu-daily-compact th:first-child{width:35%}.dtsu-daily-compact .dtsu-expanded-row td{padding-top:8px}.dtsu-daily-compact .dtsu-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}@media(max-width:760px){.dtsu-filter-bar{grid-template-columns:1fr}.dtsu-detail-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.dtsu-alias-manager-head,.dtsu-alias-row{align-items:flex-start;flex-direction:column}.dtsu-alias-actions{width:100%}}`;
      document.head.appendChild(tag);
      return () => tag.remove();
    }, []);
    (0, import_react.useEffect)(() => {
      let alive = true;
      void fetchProviderAliases().then((next) => {
        if (alive) setGroups(next);
      }).catch(() => {
      });
      return () => {
        alive = false;
      };
    }, []);
    const refresh = (0, import_react.useCallback)(async (selected, selectedFilters) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const work = [
        fetchSummary(controller.signal),
        fetchDetails(selected, selectedFilters, controller.signal),
        selected === "7d" ? void 0 : fetchDetails("7d", selectedFilters, controller.signal)
      ];
      const [nextSummary, nextDetails, nextSeven] = await Promise.all([work[0], work[1], work[2] ?? Promise.resolve(void 0)]);
      if (controller.signal.aborted) return;
      if (nextSummary) setSummary(nextSummary);
      if (nextDetails) setDetails(nextDetails);
      if (nextSeven) setSevenDay(nextSeven);
      else if (selected === "7d" && nextDetails) setSevenDay(nextDetails);
      setError(!nextDetails);
    }, []);
    (0, import_react.useEffect)(() => {
      void refresh(range, filters);
      timer.current = setInterval(() => {
        if (!document.hidden) void refresh(range, filters);
      }, 3e4);
      return () => {
        if (timer.current) clearInterval(timer.current);
        request.current?.abort();
      };
    }, [range, filters, aliasVersion, refresh]);
    const overviewSeven = sevenDay?.totalTokens ?? 0;
    const c = details?.categories ?? EMPTY_METRICS;
    const rangeLabel = range === "7d" && details?.rangeStartDate && details.rangeEndDate ? details.rangeStartDate + " \u2013 " + details.rangeEndDate : void 0;
    const activeFilter = filters.provider !== null || filters.model !== null;
    const currentModels = details?.models ?? [];
    const unknownNote = details && activeFilter && (details.excludedUnclassified?.tokens ?? 0) > 0 ? replace(t("excludedUnknown"), { tokens: fullTokens(details.excludedUnclassified?.tokens ?? 0), calls: calls(details.excludedUnclassified?.calls ?? 0) }) : details && !activeFilter && details.unknownTokens > 0 ? replace(t("unknown"), { tokens: fullTokens(details.unknownTokens), calls: calls(details.unknownCallCount) }) : void 0;
    const setFilterState = (next) => {
      setExpandedModel(void 0);
      setFilters({ provider: next.provider ?? null, model: next.model ?? null });
    };
    const modelKey = (model) => providerScopeKey(model.providerScope) + "\0" + model.provider + "\0" + model.model;
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
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-range-switch", role: "tablist", "aria-label": t("details"), children: ["today", "yesterday", "7d", "all"].map((key) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", role: "tab", "aria-selected": range === key, className: range === key ? "is-active" : "", onClick: () => setRange(key), children: t(key) }, key)) })
      ] }),
      !details && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dtsu-loading", children: error ? t("unavailable") : t("loading") }),
      details && /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(ScopeFilters, { details, filters, setFilters: setFilterState, t }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AliasManager, { groups, setGroups, onChanged: (deletedId) => {
          if (deletedId !== void 0 && filters.provider?.type === "group" && filters.provider.id === deletedId) {
            setFilterState({ provider: null, model: filters.model ?? null });
          }
          setAliasVersion((value) => value + 1);
        }, t }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-metrics-grid", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("total"), value: details.totalTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("input"), value: c.inputTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("output"), value: c.outputTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("cacheRead"), value: c.cacheReadTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("cacheWrite"), value: c.cacheWriteTokens }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("reasoning"), value: c.reasoningTokens, hint: t("reasoningHint") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Metric, { label: t("calls"), value: c.callCount })
        ] }),
        unknownNote && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { className: "dtsu-note", children: unknownNote }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dtsu-table-title", children: t("byModel") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { className: "dtsu-table dtsu-compact-table", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("provider") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("model") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("total") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("calls") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { "aria-label": t("details") })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: currentModels.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { colSpan: 5, className: "dtsu-empty-row", children: t("noMatching") }) }) : currentModels.map((model) => {
            const key = modelKey(model);
            const expanded = expandedModel === key;
            const scope = model.providerScope ?? { type: "raw", value: model.provider };
            return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-name-button", title: model.provider, onClick: () => setFilterState({ provider: scope, model: null }), children: model.provider }) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-model-button", title: model.model, onClick: () => setFilterState({ provider: null, model: model.model }), children: model.model }) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(model.totalTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: calls(model.callCount) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "dtsu-action-cell", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-expand-button", "aria-expanded": expanded, "aria-label": expanded ? t("collapse") : t("expand"), onClick: () => setExpandedModel(expanded ? void 0 : key), children: expanded ? "\u2212" : "+" }) })
              ] }),
              expanded && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { className: "dtsu-expanded-row", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { colSpan: 5, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(DetailMetrics, { model, t }) }) })
            ] }, key);
          }) })
        ] }) }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h3", { className: "dtsu-table-title", children: t("sevenDayDaily") }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dtsu-table-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("table", { className: "dtsu-table dtsu-compact-table dtsu-daily-compact", children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("date") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("total") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { children: t("calls") }),
            /* @__PURE__ */ (0, import_jsx_runtime.jsx)("th", { "aria-label": t("details") })
          ] }) }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tbody", { children: (sevenDay?.daily ?? []).map((day) => {
            const expanded = expandedDay === day.date;
            return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react.Fragment, { children: [
              /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("tr", { children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: day.date }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: formatTokens(day.totalTokens + day.unknownTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { children: calls(day.callCount) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { className: "dtsu-action-cell", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { type: "button", className: "dtsu-expand-button", "aria-expanded": expanded, "aria-label": expanded ? t("collapse") : t("expand"), onClick: () => setExpandedDay(expanded ? void 0 : day.date), children: expanded ? "\u2212" : "+" }) })
              ] }),
              expanded && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("tr", { className: "dtsu-expanded-row", children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("td", { colSpan: 4, children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dtsu-detail-grid", children: [
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("input"), value: formatTokens(day.inputTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("output"), value: formatTokens(day.outputTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("cacheRead"), value: formatTokens(day.cacheReadTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("cacheWrite"), value: formatTokens(day.cacheWriteTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("reasoning"), value: formatTokens(day.reasoningTokens) }),
                /* @__PURE__ */ (0, import_jsx_runtime.jsx)(MetricLine, { label: t("calls"), value: calls(day.callCount) })
              ] }) }) })
            ] }, day.date);
          }) })
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
      noMatching: "No matching usage in this range.",
      unknown: "{tokens} tokens across {calls} calls cannot be classified from older records. They remain included in Total.",
      excludedUnknown: "{tokens} tokens across {calls} calls are unclassified and excluded from this filter.",
      providerFilter: "Provider",
      modelFilter: "Model",
      allProviders: "All providers",
      allModels: "All models",
      clearFilters: "Clear filters",
      currentScope: "Current scope",
      filterHelp: "Filters use the exact names reported by DSH; no provider is hard-coded.",
      providerGroups: "Configured groups",
      rawProviders: "Raw provider names",
      includesRawNames: "includes {count} names",
      groupContains: "contains {count} raw names",
      providerAliases: "Provider aliases",
      manageAliases: "Manage aliases",
      hideAliases: "Hide aliases",
      addAlias: "Add provider group",
      editAlias: "Edit",
      deleteAlias: "Delete",
      confirmDeleteAlias: "Delete provider group \u201C{label}\u201D? Usage data will be kept.",
      aliasLabel: "Display name",
      aliasValues: "Raw provider names",
      aliasValuesHint: "Enter one exact provider name per line. Matching is case-sensitive.",
      rawBreakdown: "Raw provider breakdown",
      save: "Save",
      cancel: "Cancel",
      expand: "Show details",
      collapse: "Hide details",
      noAliasGroups: "No local provider groups yet."
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
      noMatching: "\u5F53\u524D\u8303\u56F4\u5185\u6CA1\u6709\u5339\u914D\u7528\u91CF\u3002",
      unknown: "\u6709 {tokens} tokens\u3001{calls} \u6B21\u8C03\u7528\u65E0\u6CD5\u4ECE\u65E7\u8BB0\u5F55\u4E2D\u5206\u7C7B\uFF1B\u5B83\u4EEC\u4ECD\u8BA1\u5165\u603B\u8BA1\u3002",
      excludedUnknown: "\u6709 {tokens} tokens\u3001{calls} \u6B21\u8C03\u7528\u672A\u5206\u7C7B\uFF0C\u56E0\u6B64\u672A\u8BA1\u5165\u5F53\u524D\u7B5B\u9009\u3002",
      providerFilter: "\u4F9B\u5E94\u5546",
      modelFilter: "\u6A21\u578B",
      allProviders: "\u5168\u90E8\u4F9B\u5E94\u5546",
      allModels: "\u5168\u90E8\u6A21\u578B",
      clearFilters: "\u6E05\u9664\u7B5B\u9009",
      currentScope: "\u5F53\u524D\u8303\u56F4",
      filterHelp: "\u7B5B\u9009\u4F7F\u7528 DSH \u5B9E\u9645\u4E0A\u62A5\u7684\u7CBE\u786E\u540D\u79F0\uFF0C\u4E0D\u5185\u7F6E\u4EFB\u4F55\u4F9B\u5E94\u5546\u3002",
      providerGroups: "\u5DF2\u914D\u7F6E\u5206\u7EC4",
      rawProviders: "\u539F\u59CB\u4F9B\u5E94\u5546\u540D\u79F0",
      includesRawNames: "\u5305\u542B {count} \u4E2A\u540D\u79F0",
      groupContains: "\u5305\u542B {count} \u4E2A\u539F\u59CB\u540D\u79F0",
      providerAliases: "\u4F9B\u5E94\u5546\u540D\u79F0\u6620\u5C04",
      manageAliases: "\u7BA1\u7406\u522B\u540D",
      hideAliases: "\u6536\u8D77\u522B\u540D",
      addAlias: "\u65B0\u5EFA\u4F9B\u5E94\u5546\u5206\u7EC4",
      editAlias: "\u4FEE\u6539",
      deleteAlias: "\u5220\u9664",
      confirmDeleteAlias: "\u5220\u9664\u4F9B\u5E94\u5546\u5206\u7EC4\u201C{label}\u201D\uFF1F\u7528\u91CF\u6570\u636E\u4E0D\u4F1A\u88AB\u5220\u9664\u3002",
      aliasLabel: "\u663E\u793A\u540D\u79F0",
      aliasValues: "\u539F\u59CB\u4F9B\u5E94\u5546\u540D\u79F0",
      aliasValuesHint: "\u6BCF\u884C\u586B\u5199\u4E00\u4E2A\u7CBE\u786E\u7684\u539F\u59CB\u540D\u79F0\uFF0C\u533A\u5206\u5927\u5C0F\u5199\u3002",
      rawBreakdown: "\u539F\u59CB\u540D\u79F0\u660E\u7EC6",
      save: "\u4FDD\u5B58",
      cancel: "\u53D6\u6D88",
      expand: "\u5C55\u5F00\u660E\u7EC6",
      collapse: "\u6536\u8D77\u660E\u7EC6",
      noAliasGroups: "\u5C1A\u672A\u914D\u7F6E\u672C\u5730\u4F9B\u5E94\u5546\u5206\u7EC4\u3002"
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
  function hasSidebarAncestry(button) {
    let node = button.parentElement;
    let depth = 0;
    while (node && depth < 12) {
      const cls = typeof node.className === "string" ? node.className : "";
      if (/sidebar|newSession|left-nav|session-list/i.test(cls)) return true;
      node = node.parentElement;
      depth += 1;
    }
    return false;
  }
  function isLikelyNewSessionButton(button) {
    if (typeof button.className === "string" && button.className.includes("newSession")) return true;
    if (!hasSidebarAncestry(button)) return false;
    const label = (button.getAttribute("aria-label") ?? "").toLowerCase().replace(/\s+/g, "");
    if (!label) return false;
    return /new|session|neues|会话|新建/.test(label);
  }
  function findNewSessionButton() {
    const buttons = Array.from(document.querySelectorAll("button"));
    const exact = buttons.filter((b) => typeof b.className === "string" && b.className.includes("newSession"));
    if (exact.length > 0) return exact[0];
    return buttons.find(isLikelyNewSessionButton);
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
