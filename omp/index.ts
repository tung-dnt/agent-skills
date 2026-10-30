import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { interceptNativeTodoCall, type NativeTodoGateContext } from "./native-todo-gate.ts";
import { VerificationService, registerVerificationCommand, registerVerificationTool, type VerificationHostContext } from "./verification-tool.ts";

export default function agentSkills(pi: ExtensionAPI): void {
	const verification = new VerificationService({ appendEntry: pi.appendEntry });
	registerVerificationTool(pi, verification);
	registerVerificationCommand(pi, verification);

	pi.on("tool_call", async (event: { readonly toolName: string; readonly input: unknown }, context: VerificationHostContext) => {
		if (event.toolName !== "todo") return;
		if (typeof event.input !== "object" || event.input === null || Array.isArray(event.input)) return { block: true, reason: "Native todo arguments could not be inspected safely; read todo view before retrying." };
		return await interceptNativeTodoCall(
			{ toolName: event.toolName, input: event.input as Record<string, unknown> },
			context,
			{
				bindingStates: (todoContext: NativeTodoGateContext) => verification.bindingStates(todoContext),
				validate: (state, todoContext) => verification.validateBindingState(state, todoContext),
			},
		);
	});

	pi.on("session_shutdown", async () => {
		await verification.runner.interruptAll();
	});
}

