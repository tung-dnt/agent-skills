export interface ApprovalUI {
	readonly hasUI: boolean;
	confirm(title: string, message: string): Promise<boolean>;
}

export interface ApprovalRequest {
	readonly title: string;
	readonly workId: string;
	readonly item: string;
	readonly repository: string;
	readonly policyDigest: string;
	readonly scopeArtifact: string;
	readonly scopeDigest: string;
	readonly scopeText: string;
	readonly profile: string;
	readonly checks: readonly string[];
	readonly commands: readonly {
		readonly id: string;
		readonly kind: "static" | "runtime";
		readonly argv: readonly string[];
		readonly preparations: readonly { readonly id: string; readonly argv: readonly string[] }[];
		readonly resource?: { readonly id: string; readonly argv: readonly string[] };
	}[];
	readonly changedPaths: readonly string[];
}

export type ApprovalResult =
	| { readonly allowed: true }
	| { readonly allowed: false; readonly code: "APPROVAL_UNAVAILABLE" | "APPROVAL_DECLINED"; readonly reason: string };

export async function requestUserApproval(ui: ApprovalUI, request: ApprovalRequest): Promise<ApprovalResult> {
	if (!ui.hasUI) {
		return { allowed: false, code: "APPROVAL_UNAVAILABLE", reason: "Verification scope approval requires an interactive user-facing UI." };
	}
	const summary = [
		`Work: ${request.workId}`,
		`Native todo item: ${request.item}`,
		`Repository: ${request.repository}`,
		`Policy SHA-256: ${request.policyDigest}`,
		`Scope artifact: ${request.scopeArtifact}`,
		`Scope SHA-256: ${request.scopeDigest}`,
		"Scope artifact contents:",
		request.scopeText,
		`Profile: ${request.profile}`,
		`Required checks: ${request.checks.join(", ") || "none"}`,
		"Approved named commands:",
		...request.commands.flatMap((command) => [
			`  ${command.id} (${command.kind}): ${JSON.stringify(command.argv)}`,
			...command.preparations.map((preparation) => `  preparation ${preparation.id}: ${JSON.stringify(preparation.argv)}`),
			...(command.resource ? [`  resource ${command.resource.id} generation probe: ${JSON.stringify(command.resource.argv)}`] : []),
		]),
		`Candidate changes (${request.changedPaths.length}):`,
		...(request.changedPaths.length > 0 ? request.changedPaths.map((file) => `  ${file}`) : ["  none"]),
		"",
		"Approval binds these exact inputs. Later changes require a new approval.",
	].join("\n");
	let allowed: boolean;
	try {
		allowed = await ui.confirm(request.title, summary);
	} catch (error) {
		return { allowed: false, code: "APPROVAL_UNAVAILABLE", reason: `The approval UI failed: ${error instanceof Error ? error.message : String(error)}` };
	}
	return allowed
		? { allowed: true }
		: { allowed: false, code: "APPROVAL_DECLINED", reason: "The user declined verification scope approval." };
}
