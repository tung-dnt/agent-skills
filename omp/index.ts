// omp extension for agent-skills: the `work_state` tool (the work-artifact store, claims, and
// approvals behind /story, /plan, /build) and the SessionStart hint about claimed tasks.
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { OPS, runWorkState, workStateHint } from "./work-state";

const DESCRIPTION =
	"Read and write agent-skills work state: where epics, stories, and tasks live (an Obsidian vault or the repo), " +
	"task notes and their status, parallel-session claims (git lock refs), design and phase approvals, and the " +
	"story phase. `op` names the operation; `args` are its positional arguments in CLI order, e.g. op `set` with " +
	"args [STORY, TASK, STATUS]; op `claim` with [STORY, TASK, WORK_BRANCH?]; op `new-task` with [STORY, TITLE, DEP-ID...]. " +
	"Operations: root, configure DIR [EPICS_DIR], init-epic EPIC TITLE, init-story STORY TITLE [EPIC], new-task, path STORY [TASK], " +
	"field STORY TASK KEY VALUE, set STORY TASK STATUS, log STORY TASK TEXT, next [STORY], ready STORY, claim, release STORY TASK, " +
	"status [STORY], brief STORY TASK, phase STORY, approve STORY TASK [--allow-long], approved STORY TASK, approve-phase STORY PHASE, " +
	"approved-phase STORY PHASE, adopt-approvals STORY, cites STORY ID, migrate [STORY], hint. " +
	"The result is the operation's stdout, then its stderr, then a final line `exit: <code>` when the code is not 0. " +
	"Exit codes carry meaning: 3 = lost the claim race (another session holds the task), 4 = nothing claimable / no task ready, " +
	"5 = the claim could not be published to the remote, 6 = not approved, 7 = changed since approval; 1 = error (message on stderr). " +
	"`cwd` defaults to the session's directory; a relative `cwd` resolves against it.";

export default function agentSkills(pi: ExtensionAPI): void {
	const z = pi.zod;

	pi.registerTool({
		name: "work_state",
		label: "Work State",
		description: DESCRIPTION,
		parameters: z.object({
			op: z.enum(OPS).describe("The operation to run"),
			args: z.array(z.string()).optional().describe("Positional arguments of the operation, in CLI order"),
			cwd: z.string().optional().describe("Directory inside the repository to run in (default: the session's directory)"),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const p = params as { op: string; args?: string[]; cwd?: string };
			const cwd = path.resolve(ctx.cwd, p.cwd ?? ".");
			const { code, stdout, stderr } = await runWorkState([p.op, ...(p.args ?? [])], { cwd });
			let text = stdout;
			if (stderr) text += `${text && !text.endsWith("\n") ? "\n" : ""}${stderr}`;
			if (code !== 0) text += `${text && !text.endsWith("\n") ? "\n" : ""}exit: ${code}`;
			return { content: [{ type: "text", text: text || "(no output)" }], details: { op: p.op, code } };
		},
	});

	// Port of agent-skills' Claude SessionStart hook: the claimed-task /resume hint, injected on the first turn.
	let pending: Promise<string | undefined> | undefined;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		pending = Promise.resolve()
			.then(() => workStateHint({ cwd: ctx.cwd }))
			.catch(() => undefined);
	});

	pi.on("before_agent_start", async () => {
		if (!pending) return;
		const hint = await pending;
		pending = undefined;
		if (!hint) return;
		return { message: { customType: "agent-skills-work-state", content: hint, display: true } };
	});
}
