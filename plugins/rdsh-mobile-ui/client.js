window.__ModuleLoader__.load({
  id: "rdsh-mobile-ui",
  factory(require) {
    // rdsh スマホUI — phone-width layout for the DSH Web chat.
    //
    // Adapted from the mobile rail of Smart-DSH (the browser half of its
    // dsh-notify-push bundle) by hikarioyama, MIT:
    //   https://github.com/hikarioyama/Smart-DSH
    // Smart-DSH ships that responsive layer together with Web Push
    // notifications, Esc-to-stop, a task hub and a shared-HMR workaround;
    // this bundle keeps only the phone layout and nothing else.
    //
    // Upstream class names are CSS-module hashes and change between DSH
    // releases; a rename only stops a rule from matching and leaves the stock
    // layout in place (fail closed). Verified against DSH 0.2.0-rc.2:
    // dsh-client-ui-layout renders .pI_x6G_frame / _sidebarCol / _centerCol /
    // _rightbarCol (0.1.2-rc.1 called that column _detailsCol, kept below),
    // dsh-client-ui-sidebar renders .hHd-Xa_*, and the chat column is
    // .wSkVaW_root.
    const MOBILE_QUERY = "(max-width: 767px)";
    const RAIL_ATTRIBUTE = "data-rdsh-mobile-rail";
    const STYLE_ATTRIBUTE = "data-rdsh-mobile-ui";
    const RAIL_CLOSED = "closed";

    const CSS = `@media (max-width: 767px) {
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] { grid-template-columns: 0px minmax(0,1fr) 0px !important; }
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] > .pI_x6G_centerCol { grid-column: 2; grid-row: 1; }
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] > .pI_x6G_detailsCol,
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] > .pI_x6G_rightbarCol { grid-column: 3; grid-row: 1; }
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] > .pI_x6G_sidebarCol { position: absolute; top: 0; left: 0; width: 56px; height: 64px; z-index: 10; border: 0; }
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] .hHd-Xa_root { height: 64px; }
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] .hHd-Xa_newSession,
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] .hHd-Xa_regionArea,
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] .hHd-Xa_footArea { display: none; }
  html[data-rdsh-mobile-rail="closed"] .pI_x6G_frame[data-sidebar-collapsed] .wSkVaW_header:not([aria-hidden="true"]) { padding-left: 64px; }
  html[data-rdsh-mobile-rail] .hHd-Xa_collapsed .hHd-Xa_toggle .hHd-Xa_railMark { display: inline-flex !important; }
  html[data-rdsh-mobile-rail] .hHd-Xa_collapsed .hHd-Xa_toggle .hHd-Xa_panelIcon { display: none !important; }
  /* Only the mobile logo: no tooltip, sticky hover tint, or Android tap flash. */
  html[data-rdsh-mobile-rail] .hHd-Xa_toggle,
  html[data-rdsh-mobile-rail] .hHd-Xa_toggle:is(:hover,:active,:focus) { color: var(--dsw-alias-label-primary) !important; background: transparent !important; -webkit-tap-highlight-color: transparent; }
  html[data-rdsh-mobile-rail] .hHd-Xa_toggle * { -webkit-tap-highlight-color: transparent; }
  html[data-rdsh-mobile-rail]:has(.hHd-Xa_toggle:is(:hover,:focus)) [role="tooltip"] { display: none !important; }
  /* Upstream content width floors at 680px. On a narrow phone that card is
     wider than the viewport, so size it from the column instead of pixels. */
  .pI_x6G_centerCol,
  .wSkVaW_root { width: 100%; min-width: 0; max-width: 100%; overflow-x: clip; }
  .wSkVaW_root {
    --dsh-chat-user-width: 100% !important;
    --dsh-chat-content-width: 100% !important;
    --dsh-composer-card-max-width: 100% !important;
  }
  [data-question-key],
  [data-plan-review-key] {
    box-sizing: border-box;
    align-self: stretch;
    width: 100%;
    max-width: min(100%, 95vw);
    min-width: 0;
    padding-left: 2.5%;
    padding-right: 2.5%;
    overflow-wrap: anywhere;
  }
  [data-question-key] > :first-child,
  [data-plan-review-key] > :first-child { box-sizing: border-box; width: 100%; max-width: 100%; min-width: 0; }
  [data-question-key] footer,
  [data-plan-review-key] footer { width: 100%; flex-wrap: wrap; min-width: 0; max-width: 100%; row-gap: 8px; }
}`;

    function installPhoneLayout(ctx) {
      if (typeof document === "undefined") return;
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      ctx.effect(() => {
        const media = window.matchMedia(MOBILE_QUERY);
        const root = document.documentElement;
        const style = document.createElement("style");
        style.setAttribute(STYLE_ATTRIBUTE, "true");
        style.textContent = CSS;
        document.head.appendChild(style);
        const reset = () => {
          if (media.matches) root.setAttribute(RAIL_ATTRIBUTE, RAIL_CLOSED);
          else root.removeAttribute(RAIL_ATTRIBUTE);
        };
        // The logo click is never intercepted. On a phone that button is the
        // collapsed-sidebar toggle, so letting it through opens the session
        // list in one step instead of the intermediate icon rail.
        reset();
        media.addEventListener("change", reset);
        return () => {
          style.remove();
          root.removeAttribute(RAIL_ATTRIBUTE);
          media.removeEventListener("change", reset);
        };
      }, "rdsh-mobile-ui: phone layout");
    }

    return {
      inject: [],
      apply(ctx) {
        installPhoneLayout(ctx);
      },
    };
  },
});
