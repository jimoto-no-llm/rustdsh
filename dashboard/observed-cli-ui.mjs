import { formatDateTime, text } from "./locale.mjs";

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function setupObservedCli({ api }) {
  const panel = document.getElementById("observed-cli-panel");
  if (!panel) return null;

  const form = document.getElementById("observed-cli-form");
  const taskSelect = document.getElementById("observed-cli-task");
  const kindSelect = document.getElementById("observed-cli-kind");
  const pidInput = document.getElementById("observed-cli-pid");
  const status = document.getElementById("observed-cli-status");
  const list = document.getElementById("observed-cli-list");
  let taskOptions = "";
  let refreshing = false;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const result = await api("observed-cli");
      list.replaceChildren();
      if (!result.processes.length) {
        list.append(element("p", text("observed.empty")));
        return;
      }
      for (const process of result.processes) {
        const item = element("article", undefined, "event");
        const task = process.task_id
          ? ` · ${text("observed.task", { id: process.task_id })}${process.task_present ? "" : ` · ${text("observed.removed")}`}`
          : ` · ${text("observed.project")}`;
        item.append(
          element(
            "h3",
            `${process.cli_kind} · PID ${process.pid} · ${["alive", "gone", "pid_reused", "owner_mismatch", "unknown"].includes(process.status) ? text("observed.status." + process.status) : process.status_label}`,
          ),
          element("p", task),
          element(
            "p",
            text("observed.registered", { registered: formatDateTime(process.registered_at), observed: formatDateTime(process.observed_at) }),
            "sub",
          ),
        );
        const unregister = element("button", text("observed.unregister"));
        unregister.type = "button";
        unregister.addEventListener("click", async () => {
          if (
            !confirm(
              text("observed.confirm", { pid: process.pid }),
            )
          )
            return;
          unregister.disabled = true;
          try {
            await api(`observed-cli/${encodeURIComponent(process.id)}`, undefined, "DELETE");
            status.textContent = text("observed.unregistered");
            await refresh();
          } catch (error) {
            status.textContent = error.message;
            unregister.disabled = false;
          }
        });
        item.append(unregister);
        list.append(item);
      }
      status.textContent = text("observed.refreshed");
    } catch (error) {
      status.textContent = error.message;
      list.replaceChildren();
    } finally {
      refreshing = false;
    }
  }

  function render(state) {
    const signature = JSON.stringify(
      (state.tasks || []).map((task) => [task.id, task.title]),
    );
    if (signature === taskOptions) return;
    taskOptions = signature;
    const selected = taskSelect.value;
    const options = [
      { id: "", title: text("observed.projectOption") },
      ...(state.tasks || []),
    ];
    taskSelect.replaceChildren(
      ...options.map((task) => {
        const option = element(
          "option",
          task.id ? `${task.id} · ${task.title}` : task.title,
        );
        option.value = task.id;
        return option;
      }),
    );
    if ([...taskSelect.options].some((option) => option.value === selected))
      taskSelect.value = selected;
  }

  panel.addEventListener("toggle", () => {
    if (panel.open) void refresh();
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const pid = Number(pidInput.value);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      status.textContent = text("observed.invalidPid");
      return;
    }
    const submit = document.getElementById("observed-cli-submit");
    submit.disabled = true;
    status.textContent = text("observed.checking");
    try {
      await api("observed-cli", {
        pid,
        task_id: taskSelect.value || null,
        cli_kind: kindSelect.value,
      });
      pidInput.value = "";
      status.textContent = text("observed.registeredStatus");
      await refresh();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById("observed-cli-refresh").addEventListener("click", () => {
    void refresh();
  });
  const timer = setInterval(() => {
    if (panel.open && !document.hidden) void refresh();
  }, 5000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  return { render, refresh };
}
