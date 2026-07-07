# 创建 Python 虚拟环境

python -m venv .venv

# 激活

source .venv/bin/activate # Linux / macOS

# .venv\Scripts\Activate.ps1 # Windows PowerShell

# 安装

pip install -e .
cp agent/.env.example agent/.env # Edit — set your LLM provider API key

# webui server

vibe-trading serve --port 8899

# webui环境依赖安装

cd frontend
pnpm i

# 桌端环境依赖安装

cd src-tauri/console-app
pnpm i

# 桌面端本地开发启动

cargo tauri dev
