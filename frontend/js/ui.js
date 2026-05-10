/**
 * PhantomChat — UI Helpers Module
 * Emoji picker, auto-resize, mobile sidebar, screenshot protection
 */
const PhantomUI = (() => {
  "use strict";
  const $ = (s) => document.querySelector(s);

  // Common emojis
  const EMOJIS = [
    "😀","😂","🤣","😊","😍","🥰","😘","😎","🤩","😏",
    "😢","😭","😤","🤬","😱","🤮","🤧","😴","🥱","😇",
    "🤔","🤫","🤥","😶","🙄","😬","🤐","🥴","🤒","👻",
    "💀","☠️","👽","🤖","💩","🔥","💥","✨","🌟","💫",
    "❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","❣️",
    "👍","👎","👊","✊","🤝","👏","🙏","💪","🤞","✌️",
    "🎉","🎊","🎁","🏆","🥇","🔐","🔒","🛡️","⚡","💎",
    "📎","📸","🎵","🎶","💻","📱","⌚","🔑","💰","📧",
    "✅","❌","⭕","❗","❓","💯","🆕","🆗","🔴","🟢",
    "🕐","🕑","🕒","🕓","🕔","🕕","⏰","⏳","🌙","☀️"
  ];

  function initEmojiPicker() {
    const picker = $("#emoji-picker");
    const btn = $("#emoji-btn");
    const input = $("#message-input");
    if (!picker || !btn) return;

    EMOJIS.forEach(e => {
      const b = document.createElement("button");
      b.className = "emoji-item"; b.textContent = e; b.type = "button";
      b.addEventListener("click", () => {
        if (input) { input.value += e; input.focus(); autoResize(input); }
        picker.classList.add("hidden");
      });
      picker.appendChild(b);
    });

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      picker.classList.toggle("hidden");
    });

    document.addEventListener("click", (ev) => {
      if (!picker.contains(ev.target) && ev.target !== btn) picker.classList.add("hidden");
    });
  }

  function autoResize(textarea) {
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  }

  function initAutoResize() {
    const input = $("#message-input");
    if (input) input.addEventListener("input", () => autoResize(input));
  }

  function initMobileSidebar() {
    const sidebar = $("#sidebar");
    const toggle = $("#sidebar-toggle");
    const overlay = $("#sidebar-overlay");
    const back = $("#mobile-back-btn");

    const open = () => { sidebar?.classList.add("open"); overlay?.classList.add("open"); };
    const close = () => { sidebar?.classList.remove("open"); overlay?.classList.remove("open"); };

    toggle?.addEventListener("click", open);
    overlay?.addEventListener("click", close);
    back?.addEventListener("click", () => {
      // Return to contact list view on mobile
      close();
      open();
    });

    return { openSidebar: open, closeSidebar: close };
  }

  function initScreenshotProtection() {
    // PrintScreen
    document.addEventListener("keyup", (e) => {
      if (e.key === "PrintScreen") {
        navigator.clipboard?.writeText("⚠️ Screenshot blocked by PhantomChat").catch(() => {});
        document.body.style.filter = "brightness(0)";
        setTimeout(() => { document.body.style.filter = ""; }, 500);
      }
    });
    // Block Ctrl+P print
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "p") { e.preventDefault(); }
    });
    // Block context menu
    document.addEventListener("contextmenu", (e) => {
      if (!e.target.matches("input,textarea")) e.preventDefault();
    });
    // Blur on visibility change (alt-tab screenshot)
    document.addEventListener("visibilitychange", () => {
      const area = $("#messages-area");
      if (area) area.style.filter = document.hidden ? "blur(20px)" : "";
    });
  }

  function initPanicButton() {
    let lastEsc = 0;
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        const now = Date.now();
        if (now - lastEsc < 1000) togglePanic();
        lastEsc = now;
      }
    });
  }

  function togglePanic() {
    const cover = $("#panic-cover");
    const iframe = $("#panic-iframe");
    const isHidden = cover?.classList.contains("hidden");
    if (isHidden) {
      if (iframe) iframe.src = "https://en.wikipedia.org/wiki/Special:Random";
      cover?.classList.remove("hidden");
    } else {
      cover?.classList.add("hidden");
      if (iframe) iframe.src = "about:blank";
    }
  }

  function initLightbox() {
    $("#lightbox-close")?.addEventListener("click", () => $("#image-lightbox")?.classList.add("hidden"));
    $("#image-lightbox")?.addEventListener("click", (e) => {
      if (e.target.id === "image-lightbox") $("#image-lightbox")?.classList.add("hidden");
    });
  }

  function openLightbox(src) {
    const lb = $("#image-lightbox"); const img = $("#lightbox-image");
    if (lb && img) { img.src = src; lb.classList.remove("hidden"); }
  }

  return {
    initEmojiPicker, initAutoResize, initMobileSidebar,
    initScreenshotProtection, initPanicButton, initLightbox,
    openLightbox, autoResize, togglePanic,
  };
})();
