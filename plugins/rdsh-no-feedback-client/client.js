// Hide DSH's Feedback row from the sidebar account menu.
//
// DSH 0.2.1-rc.2 builds the signed-out menu from a fixed list in
// @deepseek-ai/dsh-client-ui-settings-account: Settings, Feedback, Sign in.
// The bundle's patch layer already turns the feedback surface off, but that
// launcher row is hard-coded and opens a form against a Remote this profile
// never serves. No slot, option or config removes it.
//
// So this client half watches the menu the component renders and hides the row
// that carries the feedback label and the paper-plane glyph together. It acts
// only on the signed-out menu (`[data-signed-out="true"]` on the trigger),
// leaves a signed-in menu untouched, and is idempotent so re-renders are safe.
// It is a DOM-level fix: a rename upstream makes it match nothing, which leaves
// the stock menu in place rather than breaking the sidebar.
window.__ModuleLoader__.load({
  id: "@local/rdsh-no-feedback-client",
  factory(require) {
    const LABELS = new Set(["Feedback", "\u610f\u89c1\u53cd\u9988", "\u30d5\u30a3\u30fc\u30c9\u30d0\u30c3\u30af"]);
    const MENU = '[role="menu"]';
    const ROW = '[role="menuitem"]';

    function isFeedbackRow(row) {
      if (!LABELS.has((row.textContent || "").trim())) return false;
      // The row glyph distinguishes it from any label-only contribution.
      return row.querySelector("svg") !== null;
    }

    function hideRows() {
      for (const menu of document.querySelectorAll(MENU)) {
        const anchor = menu.parentElement;
        // Signed-out menus only: the sign-out row is absent from them. The
        // flag sits on the trigger itself, and querySelector only looks at
        // descendants, so the check has to be a self-match.
        if (anchor && !anchor.matches('[data-signed-out="true"]')) continue;
        for (const row of menu.querySelectorAll(ROW)) {
          if (!isFeedbackRow(row) || row.hidden) continue;
          row.hidden = true;
          row.setAttribute("aria-hidden", "true");
          row.dataset.rdshNoFeedback = "1";
        }
      }
    }

    return {
      apply() {
        if (typeof document === "undefined") return;
        hideRows();
        const observer = new MutationObserver(hideRows);
        observer.observe(document.documentElement, { childList: true, subtree: true });
        return () => observer.disconnect();
      },
    };
  },
});
