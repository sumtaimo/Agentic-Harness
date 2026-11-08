# Autonomous Controller Charter & Governance Policy

This file tells the harness what it may do **on its own** ("act as me"). The bullets in
section 0 are read by the harness; everything else is read by the PO_ARCHITECT AI as context.
Edit it in plain words. To replace it and keep the old one, run task
"Harness: Import New Goal/Backlog with Snapshot" (the old charter goes to `.harness/releases/`).

## 0. Machine-readable policy (the harness reads these exact bullets)
- autonomous: off
- maxAutoTasksPerRun: 3
- allowedPaths: src/**, docs/**, tests/**, test/**
- forbiddenPaths: .git/**, .harness/**, node_modules/**, .env*, production-credentials/**
- forbiddenTools: Bash(git push:*), Bash(git remote:*), Bash(rm -rf:*), Bash(npm publish:*)
- requireRealCheck: yes

`autonomous: on` lets the scheduled controller promote READY backlog items and, when none are
left, ask the PO_ARCHITECT to write new ones. Keep it `off` until the objectives below describe
your project.

## 1. Project Identity & Operational Objectives
- System Role: Autonomous Project Lifecycle Orchestrator (acting on behalf of the Lead PO/Architect).
- Core Objective: Autonomously groom the backlog, formulate acceptance criteria, implement clean code changes, and verify test suites on a scheduled heartbeat.
- Execution Engine: Square (4-Node Orthogonal) + Swarm Mesh for parallel subtasks.
- Project objectives: (describe your product goals here, e.g. "Build a small task-list API with input validation and full test coverage")

## 2. Hard Governance Constraints (Non-Negotiable Boundaries)
- Max Autonomous Tasks Per Run: 3 (prevents runaway execution when the queue is dry) — enforced via `maxAutoTasksPerRun`.
- Forbidden Directories (Write-Protected): `.git/**`, `.harness/releases/**` (and all of `.harness/**`), `node_modules/**`, `.env*`, `production-credentials/**` — enforced via `forbiddenPaths` (plan rejected + engine deny rules).
- Forbidden Actions:
  - Never execute `git push --force` or modify git remote configurations.
  - Never run shell commands that drop databases, delete untracked migrations, or bypass security checks.
  - Never invent new third-party production dependencies without recording a decision note.
- Rollback Requirement: when `useGitWorktrees: false`, any failed 3-cycle task must automatically restore backed-up files from `.harness/staging/<taskId>/` before halting.

## 3. Role Personas & Tool Access Boundaries

| Role Persona | Mandate & Workflow | Engine tools (Claude Code permission rules) | May own files |
| :--- | :--- | :--- | :--- |
| **PO_ARCHITECT** | Prioritizes backlog, approves scope, arbitrates edge cases. Read-only: the harness writes the backlog. | `Read`, `Glob`, `Grep`, `Bash(git status)`, `Bash(git log:*)` | none |
| **BA_ANALYST** | Inspects business logic, writes functional & visual acceptance criteria. | `Read`, `Edit/Write(<its targetFiles>)`, `Bash(git status)` | `docs/**` |
| **DEV_ENGINEER** | Implements code changes strictly within scoped `targetFiles`. | `Read`, `Edit/Write(<its targetFiles>)`, `Bash(npm:*)`, `Bash(node:*)`, read-only git | anything allowed |
| **QA_AUDITOR** | Writes/runs tests, identifies regression risks, verifies AC. | `Read`, `Edit/Write(<its targetFiles>)`, `Bash(npm test:*)` | `tests/**`, `test/**`, `*.test.*`, `*.spec.*` |

Role files live in `.harness/roles/*.json`; skills in `.harness/skills/<name>/SKILL.md`.

## 4. Acceptance Criteria & Quality Gates
Before any task can transition from `3_VERIFIER` to `4_COMMITTED`:
1. **Deterministic Verification:** the task's `verifyCmd` (or the package.json check) must exit with code `0`. AI-suggested checks are recorded, never run.
2. **Zero Scope Creep:** only files declared in `targetFiles` may be modified (engine permission rules + staging rollback; strict with `useGitWorktrees: true`).
3. **Audit Trail:** every run is appended to `.harness/telemetry.log` and recorded in `.harness/memory/sessions/`.
