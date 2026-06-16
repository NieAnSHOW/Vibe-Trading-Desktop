// grid.js — 网格速拨页交互
// 依赖 window.__TAURI__ (withGlobalTauri 注入)

/** 从 sites.json 加载站点配置 */
async function loadSites() {
  try {
    const resp = await fetch('sites.json');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data.sites || [];
  } catch (err) {
    console.error('Failed to load sites.json:', err);
    // 回退：硬编码默认站点
    return [
      { id: 'sina_finance', name: '新浪财经', url: 'https://finance.sina.com.cn/', icon: '📈' },
      { id: '10jqka', name: '同花顺', url: 'https://www.10jqka.com.cn/', icon: '📊' },
    ];
  }
}

/** 点击站点卡片：调用 Rust open_news_tab 命令 */
function openNewsTab(site) {
  // Tauri 2 自动 camelCase 转换：Rust 侧 site_id ↔ JS 侧 siteId
  window.__TAURI__.core.invoke('open_news_tab', {
    url: site.url,
    title: site.name,
    siteId: site.id,
  });
}

/** 渲染站点卡片网格 */
function renderGrid(sites) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  for (const site of sites) {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<div class="ico">' + (site.icon || site.name[0]) + '</div>' +
      '<div class="name">' + site.name + '</div>';
    card.addEventListener('click', () => openNewsTab(site));
    grid.appendChild(card);
  }
}

// --- 启动 ---
loadSites().then(renderGrid);
