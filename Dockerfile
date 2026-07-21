# syntax=docker/dockerfile:1.6
#
# Multi-stage build for LURE Meta Platform.
#
# Why a Dockerfile (not zeabur.json buildCommand):
#   Zeabur's auto-detection sees `requirements.txt` at the repo root
#   and picks the Python buildpack, which only runs `pip install` —
#   completely ignoring any `pnpm build` step. The result would be
#   no `dist/`, so FastAPI would serve a minimal placeholder at "/".
#   With this Dockerfile both stages run regardless of buildpack
#   heuristics.
#
# Stage 1: Node 20 + pnpm → frontend/ → dist/
# Stage 2: Python 3.11 slim → uvicorn serves FastAPI + the dist/
#          built in stage 1 (copied across)

# ── Stage 1: build the React/Vite frontend ────────────────────────
FROM node:20-alpine AS frontend-builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

# Install deps first so layer caches when only source changes
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/
RUN cd frontend && pnpm install --frozen-lockfile

# Now copy everything the build actually reads. Vite's outDir is
# `../dist` so the build emits to /app/dist (one level above
# /app/frontend) — that's why we copy frontend/ into /app/frontend.
COPY frontend ./frontend
RUN cd frontend && pnpm build

# ── Stage 2: Python runtime ───────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Install Python deps first (better cache reuse)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the FastAPI server source. dist/ (the React build output,
# plus favicon.png / icon-192.png / icon-512.png which Vite copies
# from frontend/public/) comes from stage 1.
#
# Add new top-level Python modules here as they're created — the
# COPY is allow-listed (not `COPY . .`) so non-runtime junk
# (.git, docs, tests, scratch files) doesn't bloat the image.
COPY main.py line_client.py ezpay_client.py agent_personas.py ./
COPY --from=frontend-builder /app/dist ./dist

# Default to 8001 locally; Zeabur sets $PORT
ENV PORT=8001
EXPOSE 8001

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
