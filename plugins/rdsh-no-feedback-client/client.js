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
// only on the signed-out menu (the component stamps it with its `signedOutMenu`
// CSS-module class), leaves a signed-in menu untouched, and is idempotent.
// It is a DOM-level fix: a rename upstream makes it match nothing, which leaves
// the stock menu in place rather than breaking the sidebar.
window.__ModuleLoader__.load({
  // The id must equal the Loader entry name: the client module system keys the
  // registered factory by that name and reports "loaded without registering"
  // when a bundle registers under a different one.
  id: "rdsh-no-feedback-client",
  factory(require) {
    const LABELS = new Set(["Feedback", "\u610f\u89c1\u53cd\u9988", "\u30d5\u30a3\u30fc\u30c9\u30d0\u30c3\u30af"]);
    const MENU = '[role="menu"]';
    const ROW = '[role="menuitem"]';

    function isFeedbackRow(row) {
      if (!LABELS.has((row.textContent || "").trim())) return false;
      // The row glyph distinguishes it from any label-only contribution.
      return row.querySelector("svg") !== null;
    }

    // The menu is portalled out of the trigger, so the signed-out flag on the
    // trigger is not an ancestor of the menu. The component does stamp the
    // menu itself with its `signedOutMenu` CSS-module class, whose prefix is
    // content-hashed but whose stable tail is `signedOutMenu`.
    function isSignedOutMenu(menu) {
      const cls = menu.className;
      if (typeof cls !== "string") return false;
      return /(?:^| )([A-Za-z0-9_-]+_signedOutMenu)(?:$| )/.test(cls);
    }

    function hideRows() {
      for (const menu of document.querySelectorAll(MENU)) {
        // Signed-out menus only: the sign-out row is absent from them.
        if (!isSignedOutMenu(menu)) continue;
        for (const row of menu.querySelectorAll(ROW)) {
          if (!isFeedbackRow(row) || row.hidden) continue;
          // `hidden` alone loses to the row's `display: flex` from the shipped
          // CSS-module rule, so the style attribute carries the hide and `hidden`
          // keeps the semantics for assistive technology.
          row.hidden = true;
          row.style.setProperty("display", "none", "important");
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
