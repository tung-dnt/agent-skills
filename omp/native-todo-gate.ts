import type { NativeBindingState, NativeBranchEntry } from "./verification-bindings.ts";
import type { EvidenceDecision } from "./verification-gate.ts";

export interface NativeTodoItem {
	readonly content: string;
	readonly status: "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
}

export interface NativeTodoPhase {
	readonly name: string;
	readonly tasks: readonly NativeTodoItem[];
}

export interface NativeTodoSnapshot {
	readonly phases: readonly NativeTodoPhase[];
	readonly readback: boolean;
}

export interface NativeTodoGateContext {
	readonly sessionManager: {
		getBranch(): readonly NativeBranchEntry[];
		getSessionFile(): string | undefined;
	};
	readonly cwd?: string;
	readonly agent?: { readonly kind?: string };
}

export interface NativeTodoGateServices {
	bindingStates(context: NativeTodoGateContext): Promise<readonly NativeBindingState[]>;
	validate(binding: NativeBindingState, context: NativeTodoGateContext): Promise<EvidenceDecision>;
}

export interface NativeTodoCall {
	readonly toolName: string;
	readonly input: Record<string, unknown>;
}

export interface NativeTodoGateDecision {
	readonly block: true;
	readonly reason: string;
}

export async function interceptNativeTodoCall(
	call: NativeTodoCall,
	context: NativeTodoGateContext,
	services: NativeTodoGateServices,
): Promise<NativeTodoGateDecision | undefined> {
	if (call.toolName !== "todo" || context.agent?.kind === "sub") return undefined;
	const operation = resolveOperation(call.input);
	if (operation !== "done" && operation !== "drop" && operation !== "rm" && operation !== "init") return undefined;
	let bindings: readonly NativeBindingState[];
	try {
		bindings = await services.bindingStates(context);
	} catch {
		return { block: true, reason: "Native verification bindings are ambiguous. Read the current todo view and rebind or cancel registered work before changing it." };
	}
	const effectiveBindings = new Map<string, NativeBindingState>();
	for (const state of bindings) {
		const previous = effectiveBindings.get(state.binding.item);
		if (previous && !previous.isCancelled && !state.isCancelled) {
			return { block: true, reason: "Multiple live verification bindings target identical todo content. Read the todo view and rebind before completion." };
		}
		if (!previous || previous.isCancelled) effectiveBindings.set(state.binding.item, state);
	}
	bindings = [...effectiveBindings.values()];
	if (bindings.length === 0) return undefined;
	const snapshot = latestTodoSnapshot(context.sessionManager.getBranch());
	if (!snapshot) return { block: true, reason: "Current native todo state is unknown. Call todo with op=view, then retry the protected transition." };
	const allItems = snapshot.phases.flatMap((phase) => phase.tasks);
	if (hasDuplicateContents(allItems)) return { block: true, reason: "Native todo items are ambiguous. Read the todo view and make registered item content unique before changing it." };
	const missingBindings = bindings.filter((state) => !state.isCancelled && !allItems.some((item) => item.content === state.binding.item));
	if (missingBindings.length > 0) {
		return {
			block: true,
			reason: snapshot.readback
				? "A registered todo item is missing or renamed. Rebind its exact current content or explicitly cancel verification before continuing."
				: "A registered todo item is missing or renamed. Call todo with op=view, then rebind its exact current content or explicitly cancel verification.",
		};
	}

	if (operation === "done") {
		const targets = selectTargets(call.input, snapshot.phases);
		for (const item of targets) {
			if (item.status === "completed") continue;
			const state = findBinding(bindings, item.content);
			if (!state) continue;
			if (state.isCancelled) return { block: true, reason: `Cancelled work cannot be marked complete: ${item.content}` };
			try {
				const decision = await services.validate(state, context);
				if (!decision.allowed) return { block: true, reason: `Native todo completion requires fresh verification evidence for ${item.content}: ${decision.reason}` };
			} catch {
				return { block: true, reason: `Native todo completion could not validate current verification evidence for ${item.content}; read todo view and verification status.` };
			}
		}
		return undefined;
	}

	const currentContents = new Set(allItems.map((item) => item.content));
	const affected = operation === "init"
		? [...currentContents].filter((content) => !initContents(call.input).has(content))
		: selectTargets(call.input, snapshot.phases).map((item) => item.content);
	for (const state of bindings) {
		const item = allItems.find((candidate) => candidate.content === state.binding.item);
		if (!item || !affected.includes(state.binding.item) || isClosed(item.status)) continue;
		if (!state.isCancelled) return { block: true, reason: `Removing or abandoning unfinished registered work requires an explicit user-approved verification cancel first: ${item.content}` };
	}
	return undefined;
}

export function latestTodoSnapshot(branch: readonly NativeBranchEntry[]): NativeTodoSnapshot | undefined {
	let latest: NativeTodoSnapshot | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === "user_todo_edit") {
			const data = asRecord(entry.data);
			const phases = data ? parsePhases(data.phases) : undefined;
			latest = phases ? { phases, readback: false } : undefined;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = asRecord(entry.message);
		if (message?.role !== "toolResult" || message.toolName !== "todo" || message.isError === true) continue;
		const details = asRecord(message.details);
		const phases = details ? parsePhases(details.phases) : undefined;
		if (phases) latest = { phases, readback: details?.op === "view" };
	}
	return latest;
}

function resolveOperation(input: Record<string, unknown>): string | undefined {
	if (typeof input.op === "string") return input.op;
	if (Array.isArray(input.list) || Array.isArray(input.items) && input.phase === undefined) return "init";
	return undefined;
}

function parsePhases(value: unknown): readonly NativeTodoPhase[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const phases: NativeTodoPhase[] = [];
	for (const raw of value) {
		const phase = asRecord(raw);
		if (!phase || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return undefined;
		const tasks: NativeTodoItem[] = [];
		for (const rawTask of phase.tasks) {
			const task = asRecord(rawTask);
			if (!task || typeof task.content !== "string" || !isTodoStatus(task.status)) return undefined;
			tasks.push({ content: task.content, status: task.status });
		}
		phases.push({ name: phase.name, tasks });
	}
	return phases;
}

function selectTargets(input: Record<string, unknown>, phases: readonly NativeTodoPhase[]): readonly NativeTodoItem[] {
	if (typeof input.task === "string") return phases.flatMap((phase) => phase.tasks.filter((task) => task.content === input.task));
	if (typeof input.phase === "string") return phases.find((phase) => phase.name === input.phase)?.tasks ?? [];
	return phases.flatMap((phase) => phase.tasks);
}

function initContents(input: Record<string, unknown>): Set<string> {
	const contents = new Set<string>();
	if (Array.isArray(input.list)) {
		for (const rawPhase of input.list) {
			const phase = asRecord(rawPhase);
			if (!phase || !Array.isArray(phase.items)) continue;
			for (const item of phase.items) if (typeof item === "string") contents.add(item);
		}
	} else if (Array.isArray(input.items)) {
		for (const item of input.items) if (typeof item === "string") contents.add(item);
	}
	return contents;
}

function findBinding(bindings: readonly NativeBindingState[], item: string): NativeBindingState | undefined {
	const matches = bindings.filter((state) => state.binding.item === item);
	if (matches.length > 1) throw new Error("Multiple verification bindings target the same todo item.");
	return matches[0];
}

function hasDuplicateContents(items: readonly NativeTodoItem[]): boolean {
	const seen = new Set<string>();
	for (const item of items) {
		if (seen.has(item.content)) return true;
		seen.add(item.content);
	}
	return false;
}

function isClosed(status: NativeTodoItem["status"]): boolean {
	return status === "completed" || status === "abandoned";
}

function isTodoStatus(value: unknown): value is NativeTodoItem["status"] {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "abandoned" || value === "blocked";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
