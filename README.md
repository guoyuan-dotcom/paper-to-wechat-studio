# Paper to WeChat Studio

把科研论文 PDF 转成适合公众号发布的中文线程稿、长文稿、HTML 和 Word 文档。

## 功能

- 上传论文 PDF 并解析全文结构
- 提取标题、作者、期刊、DOI、关键词和章节信息
- 调用 Moonshot / Kimi 生成推文线程和长文稿
- 导出 HTML 和 `.docx`
- 在前端显示实时进度和后端事件流

## Kimi Key 规则

- 应用不会使用后端保存的默认 Kimi key
- 必须在前端页面手动输入你自己的 `Kimi API Key`
- Key 只在当前页面内使用，不会写入仓库
- `backend/.env` 不应提交到 GitHub

## 项目结构

```text
research-workbench/
├─ backend/                 Express API、PDF 解析、LLM 调用、导出逻辑
├─ frontend/                Next.js 前端工作台
├─ .gitignore
└─ README.md
```

## 本地启动

### 后端

```powershell
cd backend
npm install
npm start
```

默认地址：`http://localhost:3001`

### 前端

```powershell
cd frontend
npm install
npm run dev
```

默认地址：`http://localhost:3000`

### 使用流程

1. 打开 `http://localhost:3000`
2. 上传论文原文 PDF
3. 手动输入你的 `Kimi API Key`
4. 点击“生成线程与导出稿”

### 一键启动

Windows 下可以直接双击根目录的 [Launch-Dev.cmd](C:\Users\Administrator\Desktop\research-workbench\Launch-Dev.cmd)。

它会自动：

- 清理占用 `3000/3001` 的旧进程
- 在缺少依赖时执行 `npm install`
- 启动前端和后端
- 自动打开 `http://localhost:3000`

## 发布到 GitHub

首次整理后先确认：

- `backend/.env` 不存在或不包含真实密钥
- `node_modules`、`.next`、日志、导出文件、exe 打包文件都不会提交
- 根目录只保留源码、说明文档和必要配置

常用命令：

```powershell
git init -b main
git add .
git status
git commit -m "Initial commit"
git remote add origin <your-repo-url>
git push -u origin main
```

## 技术栈

- Frontend: Next.js 14, React 18, TypeScript
- Backend: Node.js, Express
- Export: `docx`
- LLM: Moonshot / Kimi
