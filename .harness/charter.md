# Autonomous Controller Charter & Governance Policy

This file tells the harness what it may do **on its own** ("act as me"). The bullets in
section 0 are read by the harness; everything else is read by the PO_ARCHITECT AI as context.
Edit it in plain words. To replace it and keep the old one, run task
"Harness: Import New Goal/Backlog with Snapshot" (the old charter goes to `.harness/releases/`).

## 0. Machine-readable policy (the harness reads these exact bullets)
- autonomous: off
- maxAutoTasksPerRun: 3
- allowedPaths: src/**, docs/**, tests/**, test/**, __tests__/**
- forbiddenPaths: .git/**, .harness/**, node_modules/**, .env*, production-credentials/**
- forbiddenTools: Bash(git push:*), Bash(git remote:*), Bash(rm -rf:*), Bash(npm publish:*)
- requireRealCheck: yes

`autonomous: on` (the default of this template) means the workflow runs by itself: it takes READY
backlog items, has the orchestrator delegate them to the named agents, verifies the result and reports to
you. It is safe to leave on because:
- it only acts on **READY items you put in the backlog**; it invents new tasks only after you replace the
  "Project objectives" placeholder below with your real goals (until then it plans nothing and spends nothing);
- it needs a **real check** (`requireRealCheck`), does at most `maxAutoTasksPerRun` tasks per run, and **pauses on any failure** for you to decide;
- every file an agent changes is checked against its assignment, anything outside is reverted, and headless
  autonomous work lands on the `uat` branch, never on `main`.
Set `- autonomous: off` to stop all of it.

## 1. Project Identity & Operational Objectives
- System Role: Autonomous Project Lifecycle Orchestrator (acting on behalf of the Lead PO/Architect).
- Core Objective: Autonomously groom the backlog, formulate acceptance criteria, implement clean code changes, and verify test suites on a scheduled heartbeat.
- Execution Engine: Square (4-Node Orthogonal) + Swarm Mesh for parallel subtasks.
- Project objectives:
  1. Core goal: maintain a zero-dependency, reusable, project-agnostic Agentic Harness template (`1_PLANNER -> 2_EXECUTOR_SWARM -> 3_VERIFIER -> 4_COMMITTED`) that anyone can drop into a new repository.
  2. Auth and cost discipline: default to local OAuth subscription CLIs (`claude`, `agy`, `codex`) with no extra token cost; allow optional `.env` API keys (git-ignored) only for budgeted team projects.
  3. Adaptive governance: support solo multi-agent workflows and role-responsive team workflows. The PO/orchestrator, `reviewer`, and `security` audit read-only; `lead-ba` writes only `docs/**`, `lead-qa` only `tests/**`, `test/**`, and `__tests__/**` (plus colocated test files), `lead-ux` only `src/**/*.css`, `*.scss`, `*.less`, `docs/ux/**/*.md`, and `lead-dev` only its assigned code files. Runtime state stays git-ignored, and a human confirms every `git push` and production deploy.
  4. Deterministic quality: evidence-first investigation (`file:line`), beyond-UI checks (validation, lifecycle, reload, permissions, regression), and 100% passing `npm test` before any commit.

## 2. Hard Governance Constraints (Non-Negotiable Boundaries)
- Max Autonomous Tasks Per Run: 3 (prevents runaway execution when the queue is dry) — enforced via `maxAutoTasksPerRun`.
- Forbidden Directories (Write-Protected): `.git/**`, `.harness/releases/**` (and all of `.harness/**`), `node_modules/**`, `.env*`, `production-credentials/**` — enforced via `forbiddenPaths` (plan rejected + engine deny rules).
- Forbidden Actions:
  - Never execute `git push --force` or modify git remote configurations.
  - Never run shell commands that drop databases, delete untracked migrations, or bypass security checks.
  - Never invent new third-party production dependencies without recording a decision note.
- Rollback Requirement: when `useGitWorktrees: false`, any failed 3-cycle task must automatically restore backed-up files from `.harness/staging/<taskId>/` before halting.
- Strict File & Test Isolation: in team/hierarchy/visible runs, `lead-dev` is strictly forbidden from creating, editing, or deleting any test files (`tests/**`, `test/**`, `__tests__/**`, `*.test.*`, `*.spec.*`); only `lead-qa` owns test files, and any test file touched by `lead-dev` is reverted immediately as a scope violation. (Solo single-worker `--mode normal` runs only edit explicit `--files`.)

## 3. Role Personas & Tool Access Boundaries

| Role Persona | Mandate & Workflow | Engine tools (Claude Code permission rules) | May own files |
| :--- | :--- | :--- | :--- |
| **PO_ARCHITECT** | Prioritizes backlog, approves scope, arbitrates edge cases. Read-only: the harness writes the backlog. | `Read`, `Glob`, `Grep`, `Bash(git status)`, `Bash(git log:*)` | none |
| **COORDINATOR** | Session A coordinator (`/harness:sessions`): manages up to 4 child sessions on isolated branches and never merges or deletes without approval. | `Read`, `Glob`, `Grep`, `Bash(node .harness/sessions.mjs:*)`, `Bash(git status)`, `Bash(git log:*)`, `Bash(git fetch:*)` | none |
| **BA_ANALYST** | Inspects business logic, writes functional & visual acceptance criteria. | `Read`, `Glob`, `Grep`, `Edit/Write(<its targetFiles>)`, `Bash(git status)` | `docs/**` |
| **DEV_ENGINEER** | Implements code changes strictly within scoped `targetFiles`. | `Read`, `Glob`, `Grep`, `Edit/Write(<its targetFiles>)`, `Bash(npm:*)`, `Bash(node:*)`, read-only git | anything allowed |
| **UX_DESIGNER** | Owns styling, design tokens, visual states, accessibility, and UX specs (`docs/ux/` flows, copy, wireframes) without altering logic. | `Read`, `Glob`, `Grep`, `Edit/Write(<its targetFiles>)`, `Bash(git status)` | `src/**/*.css`, `src/**/*.scss`, `src/**/*.less`, `docs/ux/**` |
| **QA_AUDITOR** | Writes/runs tests, identifies regression risks, verifies AC. | `Read`, `Glob`, `Grep`, `Edit/Write(<its targetFiles>)`, `Bash(npm test:*)`, `Bash(node --test:*)`, `Bash(git status)` | `tests/**`, `test/**`, `__tests__/**`, `src/**/*.test.*`, `src/**/*.spec.*`, `*.test.*`, `*.spec.*` |
| **REVIEWER** | Independent read-only code reviewer after the controller check passes. | `Read`, `Glob`, `Grep`, `Bash(git diff:*)`, `Bash(git status)`, `Bash(git log:*)` | none |
| **SECURITY** | Read-only security auditor checking secrets, injection, auth, file/network safety, and deps. | `Read`, `Glob`, `Grep`, `Bash(git diff:*)`, `Bash(git status)` | none |

Role files live in `.harness/roles/*.json`; skills in `.harness/skills/<name>/SKILL.md`.

## 4. Acceptance Criteria & Quality Gates
Before any task can transition from `3_VERIFIER` to `4_COMMITTED`:
1. **Deterministic Verification:** the task's `verifyCmd` (or the package.json check) must exit with code `0`. AI-suggested checks are recorded, never run.
2. **Zero Scope Creep:** only files declared in `targetFiles` may be modified (engine permission rules + staging rollback; strict with `useGitWorktrees: true`).
3. **Audit Trail:** every run is appended to `.harness/telemetry.log` and recorded in `.harness/memory/sessions/`.
4. **Root-Cause & Anti-Cheating Gate:** fixes must resolve the documented Root Cause (Symptom / Root Cause / Blast Radius); hardcoding returns, special-case test `if` hacks, disabling validation, weakening tests, or swallowing errors (`catch` ignore) to force exit `0` are strictly prohibited.
