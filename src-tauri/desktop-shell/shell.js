// shell.js — 标签栏状态管理
// 依赖 window.__TAURI__ (withGlobalTauri 注入)
// 使用 Tauri 2 的 invoke 和 event listen

const tabsEl = document.getElementById('tabs');
const addBtn = document.getElementById('add');

// label → { title, closable } 本地缓存
const tabs = new Map();
let activeLabel = null;

/** 全量重渲染标签栏 DOM */
function render() {
  if (!tabsEl) return;
  tabsEl.innerHTML = '';
  for (const [label, t] of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (label === activeLabel ? ' active' : '');

    // 标题
    const ttl = document.createElement('span');
    ttl.className = 'ttl';
    ttl.textContent = t.title || label;
    el.appendChild(ttl);

    // 关闭按钮：主页标签 (closable=false) 不渲染
    if (t.closable !== false) {
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        window.__TAURI__.core.invoke('close_tab', { label });
      });
      el.appendChild(x);
    }

    el.addEventListener('click', () => {
      if (label !== activeLabel) {
        window.__TAURI__.core.invoke('activate_tab', { label });
      }
    });

    tabsEl.appendChild(el);
  }
}

// --- Tauri 事件监听 ---

window.__TAURI__.event.listen('tab://opened', (e) => {
  const { label, title, closable } = e.payload;
  tabs.set(label, { title, closable });
  activeLabel = label;
  render();
});

window.__TAURI__.event.listen('tab://closed', (e) => {
  const { label } = e.payload;
  tabs.delete(label);
  render();
});

window.__TAURI__.event.listen('tab://activated', (e) => {
  activeLabel = e.payload.label;
  render();
});

// --- 「+」按钮：打开网格速拨页 ---

if (addBtn) {
  addBtn.addEventListener('click', () => {
    window.__TAURI__.core.invoke('open_grid_tab');
  });
}
