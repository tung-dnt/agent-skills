# Work Artifacts and Native Progress

This reference defines the handoff between planning, a main session, and native task workers. It deliberately does not define a project-wide task store, claim system, readiness service, or cross-session status board.

## One progress owner

- The main session owns one native todo list for its own mutable phases and progress items.
- Native task execution owns worker execution, output, cancellation, and revival.
- Static artifacts carry scope, requirements, designs, decisions, task briefs, acceptance criteria, dependencies, and expected file paths. A worker receives their absolute paths. Static artifacts do not become a second mutable status tracker.
- The main session explicitly chooses order and names one owner per shared file. Dependency ordering and ownership are coordinator decisions, not automatic DAG readiness or cross-session locking.
- Native todo/task completion is an execution/progress outcome, never proof that checks passed or that work was reviewed.

Do not configure a vault/store, create an `_tasks` board, create a replacement project JSON store, mirror task status into Markdown, or use Git refs as claims. No scope approval is inferred from an imported plan or a prior session's assertion.

## Scope and command map

| Scope | Entry point | Main output | Next |
|---|---|---|---|
| Epic or project | `/epic` | Requirements, architecture/ADRs when needed, ordered story map | `/story` |
| Story or capability | `/story` | Approved requirements, high-level design/contracts when needed, static ordered plan and worker briefs | `/build` or `/task` |
| One focused task | `/task` | Approved task design/brief and implementation | Review/integration |
| Approved implementation | `/build` | Native task-worker output and main-owned integration | `/review` / `/ship` |

Choose scope from the user request, existing requirements/design, shared-contract impact, number of independently testable slices, and uncertainty. A tracker type is input, never the decision-maker. If the command and evidence disagree, explain why and ask before changing scope.

## Static artifact contract

Use the repository's real conventions or paths the user approves; do not impose one global directory layout. A project may have `SPEC.md`, a story spec/design, a plan, ADRs, and per-worker briefs. Record stable IDs for requirements and shared contracts so a brief can cite the exact decision it implements.

A useful task brief contains:

```markdown
# <Work ID> — <Title>

## Scope
<What changes and what is explicitly excluded>

## Acceptance criteria
- <Specific, observable condition>

## Dependencies and design references
<Explicit prerequisites and requirement/contract IDs>

## Verification
- <Focused check and expected result>

## Owned paths
- `path/to/file`
```

The brief and design are static approval/context artifacts. Do not add checkboxes for live task status, mutable `todo`/`done` fields, worker logs as state, claim metadata, or a project status column. If scope/design changes, stop, show the proposed change, and obtain the required user approval before changing the brief or proceeding.

## Approval and verification

The user-facing gate in `approval-gate.md` applies to requirements, design, plans, and task designs. Every task selected from a written breakdown needs an approved low-level design before code, including mechanical tasks; the note may be concise, and a repo-sized slice gate may cover multiple tasks only when every design is shown and the user explicitly approves the named slice. A genuinely ad-hoc mechanical change with no design decisions may omit LLD. Only the main session asks for and receives approval. A model-facing flag, tool argument, native todo entry, worker completion, or imported fingerprint is not approval.

The public `verification` tool and `/verification` command support only `begin`, `run`, `status`, `complete`, and `cancel`; `workId` is required for every operation. User-facing policy/scope approval precedes binding, never a model flag. `begin` binds the exact native todo item plus a static design/scope artifact and policy; `run` requires an approved named check; `complete` validates and records evidence without setting task progress; `cancel` never produces a passing receipt. Runtime checks additionally require a configured resource-provided reset/restart generation token probed before and after, with matching SHA-256 hashes. Missing/failed/malformed/changed probes refuse evidence; PID/runId is not generation, and no host/provider fallback is used. See [Native Task Workflow](../docs/native-task-workflow.md) for the public argument, slash-flag, and runtime evidence contracts.

`scopeArtifact` accepts only a repository-relative path or an owner-session `local://<relative-name>` artifact path. The local form requires a persistent owner session; custom local roots and fallback resolution are unsupported. A registered binding/evidence record is minimal session-scoped metadata, not another status/dependency list. If an artifact or native item changed, use the supported user reapproval/rebind path; after manual edits/rewind, read back native todo before protected transition.

## Build and integration ownership

- Main chooses task order and exact allowed paths before delegation; choose sequential work when shared ownership or dependencies are unclear.
- A worker handles one assigned brief, follows test-first behavior changes, runs focused checks, and reports exact commands, observed outcomes, changed paths, and unrun checks.
- Main inspects actual changes and worker output. One integration owner runs required full-suite, integration, and project-required runtime/browser checks at stable boundaries. Do not make every worker repeat full checks, and do not lower project quality criteria.
- Passing output text is not an exit result. Record only checks actually executed against the candidate being completed.

## Resume boundaries

Resume only from the current native todo view, accessible native task output, static artifact paths, and repository state. Do not promise that another session's checklist, status, approval, ownership, or dependency readiness can be reconstructed. A read-only investigator reports unavailable state rather than synthesizing it. A fresh native todo readback is required when manual edits/rewind leave protected transitions uncertain.

## External systems

A user-designated issue tracker may supply requirements or links, but it does not replace the native todo as the current session's progress owner and does not silently approve scope/design. Do not mirror the same mutable status across trackers, Markdown, and native todo. Keep the source of truth and permitted interactions explicit in the approved scope.