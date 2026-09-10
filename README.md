# AI数智作业平台

## 本地运行

```bash
npm install
npm start
```

服务启动后访问：

```text
http://localhost:8080
```

## 后端配置

DeepSeek Key 和数据库连接串都放在服务端环境变量中，前端不会保存或发送这些敏感配置。

本地开发可使用 `.env`：

```text
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_MODEL=deepseek-v4-flash-vision-exp
DATABASE_URL=postgresql://username:password@your-neon-host/neondb?sslmode=require
DATABASE_SSL=true
PORT=8080
```

线上部署时，在服务器或部署平台的环境变量面板中配置同名变量。Vercel 的 Neon 集成通常会自动注入 `POSTGRES_URL`，代码会优先读取 `DATABASE_URL`，没有时自动读取 `POSTGRES_URL`。

## Vercel 部署

项目已经包含 Vercel Serverless API：

- `/api/ai-grade`：调用 DeepSeek 阅卷。
- `/api/uploads`：保存和读取上传图片。
- `/api/pairs`：保存和读取题目答案对应关系。

在 Vercel 项目中配置：

```text
DEEPSEEK_API_KEY=your_deepseek_api_key_here
DEEPSEEK_MODEL=deepseek-v4-flash-vision-exp
DATABASE_SSL=true
```

Neon Postgres 集成会自动配置 `POSTGRES_URL`。如果没有自动注入，也可以手动添加 `DATABASE_URL`。

## 数据库

项目使用 Neon PostgreSQL 保存上传图片和题目答案对应关系。服务启动时会自动执行 `schema.sql` 创建表：

- `uploaded_images`：保存上传过的试卷、答案、单独试题、学生作答和裁剪图片。
- `question_answer_pairs`：保存题目区域与答案区域的对应关系，并关联对应裁剪图和框选坐标。

Neon 连接串通常自带 `sslmode=require`，代码会自动启用 SSL；也可以显式设置 `DATABASE_SSL=true`。

## Docker 部署

先设置 DeepSeek Key。PowerShell 使用：

```powershell
$env:DEEPSEEK_API_KEY="your_deepseek_api_key_here"
```

Linux/macOS shell 使用：

```bash
export DEEPSEEK_API_KEY="your_deepseek_api_key_here"
```

然后启动应用和 PostgreSQL：

```bash
docker compose up -d --build
```

访问：

```text
http://localhost:8080
```

数据库数据会保存到 `postgres_data` volume，不会因为应用容器重启而丢失。
