// Box 0.22.1: a script the broker adds to every page on a plugged-in touch screen.
//
// Chromium's <select> list opens in a separate pop-up window there, which the broker's
// DevTools touches can't reach (cage 0.1.4 never gives Chromium touch). This shows a
// dropdown's choices as big buttons on the page instead, for every game, whatever its kit
// version. GameKit 0.10.6 does the same inside games; this one runs first and stops theirs.
// Plain browser JavaScript, no dependencies: it's sent as a string.

export const TOUCH_PAGE_SCRIPT = `(() => {
  if (window.__bgTouchPicker) return;
  window.__bgTouchPicker = true;
  const css = (el, s) => Object.assign(el.style, s);
  function close(shade) { shade.remove(); }
  function choose(sel, value, shade) {
    const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    set.call(sel, value);
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    close(shade);
  }
  function labelOf(sel) {
    const aria = sel.getAttribute("aria-label");
    if (aria) return aria;
    if (sel.id) { const l = document.querySelector('label[for="' + CSS.escape(sel.id) + '"]'); if (l) return l.textContent.trim(); }
    const wrap = sel.closest("label");
    if (wrap) { const t = Array.from(wrap.childNodes).filter((n) => n !== sel && !(n.contains && n.contains(sel))).map((n) => n.textContent).join(" ").trim(); if (t) return t; }
    return "Choose";
  }
  function open(sel) {
    const shade = document.createElement("div");
    shade.setAttribute("role", "dialog");
    css(shade, { position: "fixed", inset: "0", zIndex: "2147483003", background: "rgba(0,0,0,0.55)", display: "grid", placeItems: "center", touchAction: "manipulation" });
    shade.addEventListener("pointerdown", (e) => { if (e.target === shade) close(shade); });
    const list = document.createElement("div");
    css(list, { width: "min(60vw, 80vh)", maxHeight: "86vh", overflowY: "auto", display: "grid", gap: "0.8vh", padding: "2.4vh", borderRadius: "2vh", background: "var(--venue-surface, #1d1f2e)", color: "var(--venue-text, #fff)", font: "600 2.8vh system-ui, sans-serif", boxShadow: "0 2vh 6vh rgba(0,0,0,0.5)" });
    const title = document.createElement("div");
    title.textContent = labelOf(sel);
    css(title, { fontSize: "3vh", fontWeight: "700", marginBottom: "1vh" });
    list.appendChild(title);
    const button = (text, onTap, current, disabled) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.disabled = !!disabled;
      css(b, { minHeight: "6.5vh", padding: "0 2vh", textAlign: "left", border: "0", borderRadius: "1vh", font: "inherit", cursor: "pointer", opacity: disabled ? "0.4" : "1", background: current ? "var(--venue-primary, #f2b33d)" : "var(--venue-bg, #2b2e42)", color: current ? "var(--venue-on-primary, #111)" : "var(--venue-text, #fff)" });
      b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); onTap(); });
      return b;
    };
    for (const child of Array.from(sel.children)) {
      if (child.tagName === "OPTGROUP") {
        const h = document.createElement("div");
        h.textContent = child.label;
        css(h, { opacity: "0.7", marginTop: "1vh", fontSize: "2.4vh" });
        list.appendChild(h);
        for (const o of Array.from(child.querySelectorAll("option"))) list.appendChild(button(o.textContent, () => choose(sel, o.value, shade), o.value === sel.value, o.disabled));
      } else if (child.tagName === "OPTION") {
        list.appendChild(button(child.textContent, () => choose(sel, child.value, shade), child.value === sel.value, child.disabled));
      }
    }
    const cancel = button("Cancel", () => close(shade), false, false);
    cancel.style.marginTop = "1vh";
    list.appendChild(cancel);
    shade.appendChild(list);
    document.body.appendChild(shade);
  }
  function onPress(e) {
    const sel = e.target && e.target.closest ? e.target.closest("select") : null;
    if (!sel || sel.disabled || sel.multiple) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === "touchstart") open(sel);
  }
  document.addEventListener("touchstart", onPress, { capture: true, passive: false });
  document.addEventListener("mousedown", onPress, true);
  document.addEventListener("click", onPress, true);
})()`;
