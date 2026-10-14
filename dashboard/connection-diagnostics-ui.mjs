import { formatDateTime, text } from "./locale.mjs";

const labels = Object.fromEntries(["ready", "observed", "failed", "unconfirmed", "stopped", "stale_credentials", "unreachable", "not_ready", "disabled", "not_installed", "login_required", "dns_required", "route_missing"].map((state) => [state, text(`diag.state.${state}`)]));
const time = (value) => value ? formatDateTime(value) : text("date.unavailable");
export function diagnosticRows(report) {
  const browser = report.browser,
    dot = report.dot;
  return [
    {
      group: "phone",
      label: "dashboard",
      value: { ...browser.dashboard, observed_at: report.observed_at },
      recovery: text("diag.dashboardRecovery"),
    },
    {
      group: "phone",
      label: text("diag.auth"),
      value: browser.authentication,
      recovery:
        browser.authentication.state === "failed"
          ? text("diag.authFailed") : text("diag.authObserved"),
    },
    {
      group: "phone",
      label: "Tailscale Serve",
      value: browser.tailscale,
      recovery:
        browser.tailscale.state === "ready"
          ? text("diag.tailscaleReady") : text("diag.tailscaleRecover"),
    },
    {
      group: "phone", label: text("diag.phone"),
      value: browser.phone,
      recovery: text("diag.phoneRecover"),
    },
    {
      group: "dot",
      label: "Secure MCP Tunnel",
      value: dot.tunnel,
      recovery:
        dot.tunnel.state === "stale_credentials"
          ? text("diag.tunnelStale")
          : dot.tunnel.state === "ready"
            ? text("diag.tunnelReady") : text("diag.tunnelRecover"),
    },
    {
      group: "dot", label: text("diag.mcpAuth"),
      value: dot.authentication,
      recovery:
        dot.authentication.state === "failed"
          ? text("diag.mcpAuthFailed") : text("diag.mcpAuthObserved"),
    },
    {
      group: "dot", label: text("diag.discovery"),
      value: dot.discovery,
      recovery: text("diag.discoveryRecover"),
    },
    {
      group: "dot",
      label: "tools/list",
      value: dot.tools,
      recovery:
        text("diag.toolsRecover"),
    },
    {
      group: "dot",
      label: "events/list",
      value: dot.events,
      recovery: text("diag.eventsRecover"),
    },
    {
      group: "dot", label: text("diag.callback"),
      value: dot.verification,
      recovery:
        text("diag.callbackRecover"),
    },
    {
      group: "dot", label: text("diag.delivery"),
      value: dot.callback,
      recovery:
        text("diag.deliveryRecover"),
    },
    {
      group: "dot", label: text("diag.response"),
      value: dot.response,
      recovery:
        text("diag.responseRecover"),
    },
  ];
}
export function renderConnectionDiagnostics(container, report, node) {
  container.replaceChildren();
  container.append(
    node(
      "p",
      text("diag.observed", { time: time(report.observed_at) }),
      "notice",
    ),
  );
  for (const group of ["phone", "dot"]) {
    const section = node("section", undefined, "card");
    section.append(node("h3", text(`diag.group.${group}`)));
    for (const row of diagnosticRows(report).filter(
      (item) => item.group === group,
    )) {
      const block = node("div", undefined, "diagnostic-stage");
      block.append(
        node("strong", `${row.label} · ${labels[row.value.state] || text("diag.state.unconfirmed")}`),
        node("p", row.recovery, "sub"),
        node(
          "p",
          text("diag.observation", { time: time(row.value.observed_at), channel: row.value.channel ? text("diag.channel", { value: row.value.channel }) : "", reason: row.value.reason ? ` · ${row.value.reason}` : "" }),
          "sub",
        ),
      );
      if (row.value.last_success !== undefined)
        block.append(
          node(
            "p",
            text("diag.last", { success: time(row.value.last_success), failure: time(row.value.last_failure) }),
            "sub",
          ),
        );
      section.append(block);
    }
    if (group === "dot") {
      const subscriptions = report.dot.subscriptions;
      section.append(
        node(
          "p",
          text("diag.subscriptions", { active: subscriptions.active, expired: subscriptions.expired }),
        ),
      );
      for (const item of subscriptions.items)
        section.append(
          node(
            "p",
            `${item.event} · ${item.state === "active" ? text("diag.active") : text("diag.expired")} · ${text("diag.expires", { time: time(item.expires_at) })}`,
            "sub",
          ),
        );
    }
    container.append(section);
  }
}
