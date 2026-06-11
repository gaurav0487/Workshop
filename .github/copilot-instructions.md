# Copilot instructions for this repository

Purpose: give Copilot/agents focused, repo-specific guidance for common workflows so sessions can act safely and effectively.

---

## Quick build / run / test commands

General:
- Many workshops are self-contained subfolders. Inspect each workshop README for specifics.

Eval-driven (TypeScript):
- cd eval-driven-agent-development
- npm install
- npm run create-slides -- <task>        # run agent on a single task (e.g. "technology")
- npm run create-slides -- --all         # run all tasks
- npm run render -- <task>               # render a generated PPTX to per-slide JPGs
- npm run eval -- <task>                 # run eval for a single task
- npm run eval -- --all --baseline       # record baseline score
- docker build -t cwc-pptx-render .      # required for rendering (run once)
- ant beta:agents create < resources/agent.yaml  # create agent resource (see YAML section)

Ship-your-first-managed-agent (Python/Streamlit):
- python 3.10+ recommended
- python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
- pip install -r requirements.txt
- cp .env.example .env (then set ANTHROPIC_API_KEY)
- streamlit run app.py
- python e2e.py   # headless end-to-end verification (exit code 0 on PASS)

Notes on single-run testing:
- For the TypeScript eval, run `npm run eval -- <task>` to run a single task's graders.
- For the SRE Agent, `python e2e.py` executes a single headless verification.

---

## High-level architecture (big picture)

- This repository is a collection of workshops (each top-level folder is a workshop). Each workshop demonstrates Managed Agents patterns, agent evals, or multi-agent composition.
- Common workshop layout:
  - resources/       ← agent + environment YAMLs to create cloud resources
  - src/ or python files ← runner, graders, or app code
  - tasks.json or tasks list ← test prompts
  - runs/ or data/    ← outputs and fixtures
  - solutions/       ← canonical solutions (do not use unless explicitly asked)

- Managed Agents pattern (common across many workshops):
  1. Agent (agent.yaml) — system prompt, model & tools
  2. Environment (environment.yaml) — where sessions run
  3. Session — binds agent + environment + mounted resources
  4. Events — user.message, agent.message, agent.custom_tool_use, user.custom_tool_result

- Eval-driven workshop flow (example): create-slides → render (Docker) → parse-pptx → graders → eval-runner outputs scores under runs/.
- Ship-your-first-managed-agent flow: Streamlit UI + SRE Agent. Implement seven functions in agent.py to enable the cloud agent to run (setup_agent, setup_environment, upload_log, start_session, stream_reply, handle_tool, delete_session).

---

## Key conventions and repository rules (important)

- DO NOT COMMIT workshop changes or secrets unless explicitly asked by a human reviewer.
- Prerequisites frequently required across workshops:
  - Node >= 22 (for TS workshops)
  - ant CLI installed (platform/agent management)
  - Docker (for PPTX rendering and other containerized tools)
  - Python 3.10+ (for some workshops)
  - ANTHROPIC_API_KEY present in environment or .env file
- .env handling: prefer reading ANTHROPIC_API_KEY from env; if helpful, record the key in a local `.env` (do NOT overwrite an existing .env).

TypeScript-specific conventions (from workshop docs):
- Every `.ts` file MUST include the license header:
  // Copyright 2026 Anthropic PBC
  // SPDX-License-Identifier: Apache-2.0
- Avoid `export default`; use named exports
- Prefer concise predicate filters (TypeScript infers type guards). Do not add unnecessary explicit type guard signatures.

YAML resource workflow (important for Managed Agents):
- Create resources by piping YAML into the `ant` CLI, for example:
  ant beta:agents create < ./resources/agent.yaml
- After successful creation, take the `id` (and `version` for agents) from the CLI response and insert at the top of the YAML:
  id: agent_abc123...
  version: 1
- Update `AGENT_ID` and `ENVIRONMENT_ID` variables in code that needs them (e.g., `src/create-slides.ts`).
- To update an agent: `ant beta:agents update < ./resources/agent.yaml` then bump `version` to the response value.

Solutions folder:
- `solutions/` and `src/graders/*` may contain reference implementations — do not import or deploy these directly unless explicitly instructed.

AI assistant configs to check:
- Several subfolders include CLAUDE.md files and workshop-specific guidance. Agents should read those when operating in that workshop directory.

---

If anything in this file should be expanded (extra workshop commands, more project-specific tips, or MCP server setups), say which workshop to target.
