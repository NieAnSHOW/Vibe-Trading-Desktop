const invoke = window.__TAURI__?.core?.invoke;
const listen = window.__TAURI__?.event?.listen;

const tabBar = document.getElementById("tab-bar");
const newTabButton = document.getElementById("new-tab");

function render(tabs) {
  tabBar.replaceChildren(...tabs.map(renderTab));
}

function renderTab(tab) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `tab${tab.active ? " active" : ""}`;
  button.role = "tab";
  button.ariaSelected = String(tab.active);
  button.title = tab.url;

  const label = document.createElement("span");
  label.className = "tab-label";
  label.textContent = tab.title;
  button.appendChild(label);

  if (tab.closable) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.ariaLabel = `关闭 ${tab.title}`;
    close.textContent = "×";
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      invoke?.("close_tab", { id: tab.id });
    });
    button.appendChild(close);
  }

  button.addEventListener("click", () => invoke?.("activate_tab", { id: tab.id }));
  return button;
}

async function loadTabs() {
  if (!invoke) {
    render([{ id: "home", title: "首页", url: "/", active: true, closable: false }]);
    return;
  }
  render(await invoke("get_tabs"));
}

newTabButton.addEventListener("click", () => {
  invoke?.("open_desktop_tab", {
    request: { title: "同花顺", url: "https://www.10jqka.com.cn/" },
  });
});

listen?.("desktop-tabs://changed", (event) => {
  render(event.payload.tabs);
});

loadTabs();
