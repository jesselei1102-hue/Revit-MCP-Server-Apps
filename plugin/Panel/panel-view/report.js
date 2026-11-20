/* Agent Canvas · Dynamic Report host (Ultraviolet) */
(function (global) {
  "use strict";

  var THEME_KEY = "mcp-agent-canvas-report-theme";
  var root = null;
  var titleEl = null;
  var subEl = null;
  var kindEl = null;
  var statsEl = null;
  var noticeEl = null;
  var bodyEl = null;
  var emptyEl = null;
  var chromeMeta = null;
  var themeBtn = null;
  var current = null;
  var activeView = "model";
  var onViewChange = null;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function preferredTheme() {
    try {
      var stored = localStorage.getItem(THEME_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch (_) {}
    return "dark";
  }

  function applyTheme(theme) {
    if (!root) return;
    var next = theme === "light" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (_) {}
    if (themeBtn) themeBtn.textContent = next === "dark" ? "☀" : "☾";
  }

  function setChromeMeta(text) {
    if (chromeMeta) chromeMeta.textContent = text || "";
  }

  function setView(view, opts) {
    var allowed = { model: 1, report: 1 };
    var next = allowed[view] ? view : "model";
    activeView = next;
    var panes = {
      model: $("view-model"),
      report: $("view-report"),
    };
    var tabs = {
      model: $("tab-model"),
      report: $("tab-report"),
    };
    Object.keys(panes).forEach(function (key) {
      if (panes[key]) panes[key].classList.toggle("is-active", next === key);
      if (tabs[key]) tabs[key].setAttribute("aria-selected", next === key ? "true" : "false");
    });
    if (next === "report") {
      setChromeMeta(current && current.title ? current.title : "Report");
    } else {
      setChromeMeta("");
    }
    if (!opts || opts.notify !== false) {
      if (typeof onViewChange === "function") onViewChange(next);
    }
    return next;
  }

  function setEmptyVisible(visible) {
    if (!emptyEl) return;
    emptyEl.hidden = !visible;
    emptyEl.classList.toggle("is-hidden", !visible);
  }

  function renderEmpty() {
    setEmptyVisible(true);
    if (bodyEl) bodyEl.innerHTML = "";
    if (titleEl) titleEl.textContent = "Dynamic report";
    if (subEl) {
      subEl.textContent =
        "Ask in chat — Schedule / GBP stay as MCP Apps; results land here via panel_show_report.";
    }
    if (kindEl) {
      kindEl.hidden = true;
      kindEl.textContent = "";
    }
    if (statsEl) {
      statsEl.hidden = true;
      statsEl.innerHTML = "";
    }
    if (noticeEl) {
      noticeEl.hidden = true;
      noticeEl.textContent = "";
      noticeEl.className = "report-notice";
    }
    if (activeView === "report") setChromeMeta("Report");
  }

  function renderStats(stats) {
    if (!statsEl) return;
    if (!stats || !stats.length) {
      statsEl.hidden = true;
      statsEl.innerHTML = "";
      return;
    }
    statsEl.hidden = false;
    statsEl.innerHTML = stats
      .map(function (item) {
        return (
          '<div class="stat"><span class="lab">' +
          escapeHtml(item.label || item.name || "") +
          '</span><span class="val">' +
          escapeHtml(item.value != null ? item.value : "") +
          "</span></div>"
        );
      })
      .join("");
  }

  function renderNotice(notice) {
    if (!noticeEl) return;
    if (!notice || !(notice.text || notice.message)) {
      noticeEl.hidden = true;
      noticeEl.textContent = "";
      noticeEl.className = "report-notice";
      return;
    }
    var tone = String(notice.tone || notice.level || "info").toLowerCase();
    noticeEl.className = "report-notice" + (tone === "error" || tone === "warn" ? " " + tone : "");
    noticeEl.textContent = String(notice.text || notice.message);
    noticeEl.hidden = false;
  }

  function renderTable(section) {
    var columns = section.columns || [];
    var rows = section.rows || [];
    if (!columns.length && rows.length && Array.isArray(rows[0])) {
      columns = rows[0].map(function (_, i) {
        return "Col " + (i + 1);
      });
    }
    if (!columns.length) return "";

    var head =
      "<thead><tr>" +
      columns
        .map(function (col) {
          return "<th>" + escapeHtml(col) + "</th>";
        })
        .join("") +
      "</tr></thead>";

    var body =
      "<tbody>" +
      rows
        .map(function (row) {
          var cells = Array.isArray(row) ? row : columns.map(function (c) {
            return row && (row[c] != null ? row[c] : row[String(c).toLowerCase()]);
          });
          return (
            "<tr>" +
            columns
              .map(function (_, i) {
                var cell = cells[i];
                return "<td>" + escapeHtml(cell == null ? "" : cell) + "</td>";
              })
              .join("") +
            "</tr>"
          );
        })
        .join("") +
      "</tbody>";

    return (
      '<div class="report-table-wrap"><table class="report-table">' +
      head +
      body +
      "</table></div>"
    );
  }

  function renderHtmlFrame(html) {
    var srcdoc =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\" />" +
      "<style>html,body{margin:0;padding:12px;font:13px/1.45 Inter,system-ui,sans-serif;color:#121118;background:#fff}" +
      "@media (prefers-color-scheme: dark){html,body{color:#ecebf3;background:#0e0d14}}</style>" +
      "</head><body>" +
      html +
      "</body></html>";
    return (
      '<iframe class="report-html-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer" srcdoc="' +
      escapeHtml(srcdoc) +
      '"></iframe>'
    );
  }

  function renderSections(sections) {
    if (!bodyEl) return;
    if (!sections || !sections.length) {
      bodyEl.innerHTML = "";
      return;
    }
    bodyEl.innerHTML = sections
      .map(function (section) {
        var parts = ['<section class="report-section">'];
        if (section.heading || section.title) {
          parts.push("<h2>" + escapeHtml(section.heading || section.title) + "</h2>");
        }
        if (section.body || section.text) {
          parts.push('<p class="body">' + escapeHtml(section.body || section.text) + "</p>");
        }
        if (section.columns || section.rows) {
          parts.push(renderTable(section));
        }
        if (section.html) {
          parts.push(renderHtmlFrame(String(section.html)));
        }
        parts.push("</section>");
        return parts.join("");
      })
      .join("");
  }

  function applyReport(report, opts) {
    current = report && typeof report === "object" ? report : null;
    if (!current) {
      renderEmpty();
      if (!opts || opts.switchView !== false) setView("report", { notify: opts && opts.notify });
      return { ok: true, empty: true };
    }

    setEmptyVisible(false);

    if (titleEl) titleEl.textContent = current.title || "Report";
    if (subEl) subEl.textContent = current.subtitle || current.summary || "";
    if (kindEl) {
      var kind = current.kind || current.type || "";
      kindEl.textContent = kind;
      kindEl.hidden = !kind;
    }

    renderStats(current.stats || current.metrics);
    renderNotice(current.notice);

    var sections = current.sections;
    if ((!sections || !sections.length) && (current.columns || current.rows)) {
      sections = [
        {
          heading: current.tableHeading || null,
          columns: current.columns,
          rows: current.rows,
        },
      ];
    }
    if ((!sections || !sections.length) && current.html) {
      sections = [{ html: current.html }];
    }
    renderSections(sections || []);

    if (current.theme === "light" || current.theme === "dark") {
      applyTheme(current.theme);
    }

    if (!opts || opts.switchView !== false) {
      setView("report", { notify: opts && opts.notify });
    } else if (activeView === "report") {
      setChromeMeta(current.title || "Report");
    }

    return {
      ok: true,
      empty: false,
      title: current.title || null,
      kind: current.kind || current.type || null,
      sectionCount: (sections && sections.length) || 0,
    };
  }

  function clearReport(opts) {
    current = null;
    renderEmpty();
    return { ok: true };
  }

  function init(options) {
    root = $("view-report");
    titleEl = $("report-title");
    subEl = $("report-subtitle");
    kindEl = $("report-kind");
    statsEl = $("report-stats");
    noticeEl = $("report-notice");
    bodyEl = $("report-body");
    emptyEl = $("report-empty");
    chromeMeta = $("chrome-meta");
    themeBtn = $("btn-theme");
    onViewChange = options && options.onViewChange;

    applyTheme(preferredTheme());
    renderEmpty();

    ["model", "report"].forEach(function (name) {
      var tab = $("tab-" + name);
      if (tab) {
        tab.addEventListener("click", function () {
          setView(name);
        });
      }
    });
    if (themeBtn) {
      themeBtn.addEventListener("click", function () {
        applyTheme(root && root.getAttribute("data-theme") === "dark" ? "light" : "dark");
      });
    }

    setView("model", { notify: false });
  }

  global.PanelReport = {
    init: init,
    setView: setView,
    getView: function () {
      return activeView;
    },
    applyReport: applyReport,
    clearReport: clearReport,
    getReport: function () {
      return current;
    },
  };
})(window);
