(function () {
  "use strict";

  var STORAGE_KEY = "agentparty_docs_lang";
  var SVG = {
    search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="9" r="6"/><path d="M14 14l4 4" stroke-linecap="round"/></svg>',
  };

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function preferredLang() {
    var saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") return saved;
    return (document.documentElement.dataset.lang || document.body.dataset.lang || "zh") === "en" ? "en" : "zh";
  }

  function setLang(lang) {
    document.documentElement.dataset.lang = lang;
    document.body.dataset.lang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    $all("[data-lang-button]").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.langButton === lang);
      btn.setAttribute("aria-pressed", btn.dataset.langButton === lang ? "true" : "false");
    });
    var copyLabel = $(".du-copy-page-label");
    if (copyLabel) copyLabel.textContent = lang === "en" ? "Copy page" : "复制页面";
    rebuildToc();
  }

  function initLang() {
    $all("[data-lang-button]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        setLang(btn.dataset.langButton);
      });
    });
    setLang(preferredLang());
  }

  function textForVisible(node) {
    var clone = node.cloneNode(true);
    $all(".du-anchor", clone).forEach(function (a) { a.remove(); });
    $all(".zh,.en", clone).forEach(function (span) {
      var lang = document.body.dataset.lang || "zh";
      if (!span.classList.contains(lang)) span.remove();
    });
    return (clone.textContent || "").replace(/\s+/g, " ").trim();
  }

  function rebuildToc() {
    var host = $("#du-toc");
    var main = $("main.du-main");
    if (!host || !main) return;
    host.innerHTML = "";
    var headings = $all("h2, h3", main);
    if (!headings.length) {
      host.style.display = "none";
      return;
    }
    host.style.display = "";
    var lang = document.body.dataset.lang || "zh";
    var label = document.createElement("div");
    label.className = "du-toc-label";
    label.textContent = lang === "en" ? "On this page" : "本页目录";
    host.appendChild(label);
    var ul = document.createElement("ul");
    var links = [];
    headings.forEach(function (heading, i) {
      if (!heading.id) heading.id = "sec-" + i;
      if (!heading.querySelector(".du-anchor")) {
        var anchor = document.createElement("a");
        anchor.className = "du-anchor";
        anchor.href = "#" + heading.id;
        anchor.setAttribute("aria-hidden", "true");
        anchor.textContent = "#";
        heading.appendChild(anchor);
      }
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = "#" + heading.id;
      a.className = heading.tagName === "H3" ? "lvl-3" : "lvl-2";
      a.textContent = textForVisible(heading);
      li.appendChild(a);
      ul.appendChild(li);
      links.push({ id: heading.id, el: heading, a: a });
    });
    host.appendChild(ul);

    if (!("IntersectionObserver" in window)) return;
    var visible = {};
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.id] = entry.isIntersecting ? entry.intersectionRatio : 0;
      });
      var best = null;
      var bestRatio = 0;
      links.forEach(function (link) {
        var ratio = visible[link.id] || 0;
        if (ratio >= bestRatio && ratio > 0) {
          best = link;
          bestRatio = ratio;
        }
      });
      if (!best) return;
      links.forEach(function (link) {
        link.a.classList.toggle("active", link === best);
      });
    }, { rootMargin: "-70px 0px -70% 0px", threshold: [0, 0.25, 0.5, 1] });
    links.forEach(function (link) { observer.observe(link.el); });
  }

  function initCopy() {
    $all(".du-code").forEach(function (block) {
      var head = $(".du-code-head", block);
      var code = $("pre code", block);
      if (!head || !code || $(".du-code-copy", head)) return;
      var btn = document.createElement("button");
      btn.className = "du-code-copy";
      btn.type = "button";
      btn.textContent = "copy";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(code.textContent || "").then(function () {
          btn.textContent = "copied";
          btn.classList.add("copied");
          setTimeout(function () {
            btn.textContent = "copy";
            btn.classList.remove("copied");
          }, 1200);
        });
      });
      head.appendChild(btn);
    });

    var pageBtn = $(".du-copy-page");
    if (pageBtn) {
      pageBtn.addEventListener("click", function () {
        navigator.clipboard.writeText(location.href).then(function () {
          pageBtn.classList.add("copied");
          var label = $(".du-copy-page-label", pageBtn);
          if (label) label.textContent = (document.body.dataset.lang === "en") ? "Copied" : "已复制";
          setTimeout(function () {
            pageBtn.classList.remove("copied");
            setLang(document.body.dataset.lang || "zh");
          }, 1200);
        });
      });
    }
  }

  function initDrawer() {
    var burger = $(".du-hamburger");
    if (burger) {
      burger.addEventListener("click", function () {
        document.body.classList.toggle("du-drawer-open");
      });
    }
    var scrim = document.createElement("div");
    scrim.className = "du-drawer-scrim";
    scrim.addEventListener("click", function () {
      document.body.classList.remove("du-drawer-open");
    });
    document.body.appendChild(scrim);
    $all(".du-sidebar a").forEach(function (a) {
      a.addEventListener("click", function () {
        document.body.classList.remove("du-drawer-open");
      });
    });
  }

  function searchItems() {
    var items = [];
    $all(".du-nav-item").forEach(function (a) {
      var group = $(".du-nav-label", a.closest(".du-nav-group"));
      items.push({
        href: a.getAttribute("href"),
        icon: textForVisible($(".du-nav-ico", a) || a).slice(0, 2),
        title: textForVisible($(".du-nav-text", a) || a),
        group: group ? textForVisible(group) : "",
        hay: ((a.textContent || "") + " " + (a.dataset.keywords || "")).toLowerCase(),
      });
    });
    return items;
  }

  function initSearch() {
    var btn = $(".du-search-btn");
    if (!btn) return;
    var overlay = document.createElement("div");
    overlay.className = "du-search-overlay";
    overlay.innerHTML =
      '<div class="du-search-box" role="dialog" aria-modal="true">' +
        '<div class="du-search-input-row">' + SVG.search + '<input class="du-search-input" autocomplete="off" /></div>' +
        '<div class="du-search-results"></div>' +
        '<div class="du-search-foot"><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>' +
      '</div>';
    document.body.appendChild(overlay);
    var input = $(".du-search-input", overlay);
    var results = $(".du-search-results", overlay);
    var active = 0;
    var current = [];

    function render() {
      var q = (input.value || "").trim().toLowerCase();
      current = searchItems().filter(function (item) {
        return !q || item.hay.indexOf(q) >= 0 || item.title.toLowerCase().indexOf(q) >= 0 || item.group.toLowerCase().indexOf(q) >= 0;
      }).slice(0, 9);
      if (!current.length) {
        results.innerHTML = '<div class="du-search-empty">No results</div>';
        return;
      }
      results.innerHTML = current.map(function (item, i) {
        return '<a class="du-search-result ' + (i === active ? 'active' : '') + '" href="' + item.href + '">' +
          '<span class="ico">' + item.icon + '</span><span>' + item.title + '</span><span class="grp">' + item.group + '</span></a>';
      }).join("");
    }

    function open() {
      active = 0;
      overlay.classList.add("open");
      input.value = "";
      render();
      setTimeout(function () { input.focus(); }, 0);
    }
    function close() {
      overlay.classList.remove("open");
    }
    btn.addEventListener("click", open);
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });
    input.addEventListener("input", function () {
      active = 0;
      render();
    });
    document.addEventListener("keydown", function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        open();
      } else if (event.key === "Escape" && overlay.classList.contains("open")) {
        close();
      } else if (overlay.classList.contains("open") && event.key === "Enter" && current[active]) {
        location.href = current[active].href;
      } else if (overlay.classList.contains("open") && event.key === "ArrowDown") {
        event.preventDefault();
        active = Math.min(active + 1, current.length - 1);
        render();
      } else if (overlay.classList.contains("open") && event.key === "ArrowUp") {
        event.preventDefault();
        active = Math.max(active - 1, 0);
        render();
      }
    });
  }

  // Agent Party shuts down on 2026-10-31: every docs page gets the shutdown/migration notice above
  // the topbar (bilingual via the existing .zh/.en spans), with the install line and uninstall guide.
  function initOcsNotice() {
    if (document.querySelector(".du-ocs-notice")) return;
    var aside = document.createElement("aside");
    aside.className = "du-ocs-notice";
    aside.setAttribute("role", "status");
    aside.innerHTML =
      '<strong><span class="zh">Agent Party 将于 2026-10-31 关停——请迁移到 open-cross-session。</span>' +
      '<span class="en">Agent Party will shut down on 2026-10-31 — please move to open-cross-session.</span></strong> ' +
      '<span class="zh">agentparty.leeguoo.com 托管服务将在 2026-10-31 停止；在此之前频道照常可用。ocs 是一个本地单文件，不需要服务器和账号：同一台机器上的 Claude Code、Codex、Pi、Hermes 会话互发消息、互相唤醒；同一局域网（或同一个 Tailscale/WireGuard 虚拟网）的电脑用 <code>ocs lan up</code> + <code>ocs lan pair</code> 配对后互通。</span>' +
      '<span class="en">The hosted service at agentparty.leeguoo.com stops on 2026-10-31; your channels keep working until that date. ocs is a single local binary with no server and no account: Claude Code, Codex, Pi and Hermes sessions message and wake each other on one machine, and machines on the same LAN (or the same Tailscale/WireGuard network) pair with <code>ocs lan up</code> + <code>ocs lan pair</code>.</span>' +
      '<div class="du-ocs-notice-install"><code>curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh</code>' +
      '<span class="zh">Windows（PowerShell）：</span><span class="en">Windows (PowerShell):</span> ' +
      '<code>irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex</code></div>' +
      '<div class="du-ocs-notice-install"><a href="https://github.com/leeguooooo/open-cross-session" target="_blank" rel="noopener">github.com/leeguooooo/open-cross-session →</a>' +
      '<a class="zh" href="https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.zh.md" target="_blank" rel="noopener">卸载本机的 Agent Party →</a>' +
      '<a class="en" href="https://github.com/leeguooooo/agentparty/blob/main/docs/uninstall.md" target="_blank" rel="noopener">Remove the local Agent Party install →</a></div>';
    var topbar = document.getElementById("du-topbar");
    if (topbar && topbar.parentNode) topbar.parentNode.insertBefore(aside, topbar);
    else document.body.insertBefore(aside, document.body.firstChild);
  }

  document.addEventListener("DOMContentLoaded", function () {
    initOcsNotice();
    initLang();
    initDrawer();
    initCopy();
    initSearch();
  });
})();
