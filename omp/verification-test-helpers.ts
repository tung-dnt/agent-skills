import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export function testPolicy(): Record<string, unknown> {
	return {
		version: 1,
		minimumProfile: "full",
		profiles: [{ id: "full", checks: ["unit"] }],
		checks: {
			unit: { argv: [process.execPath, "-e", "process.exit(0)"], kind: "static", timeoutSeconds: 10, preparations: [] },
			integration: { argv: [process.execPath, "-e", "process.exit(0)"], kind: "runtime", timeoutSeconds: 10, preparations: [], resourceId: "test-runtime" },
		},
		classifications: [
			{ pattern: "src/**", kind: "source" },
			{ pattern: "test/**", kind: "test" },
			{ pattern: "*.json", kind: "configuration" },
			{ pattern: ".omp/**", kind: "configuration" },
			{ pattern: ".gitignore", kind: "configuration" },
			{ pattern: "README.md", kind: "source" },
			{ pattern: "generated/**", kind: "generated" },
			{ pattern: "build/**", kind: "excluded" },
		],
		pathRules: [{ pattern: "src/**", checks: ["integration"] }],
		preparations: {},
		resources: { "test-runtime": { argv: [process.execPath, "-e", "process.stdout.write('generation-1')"], timeoutSeconds: 10 } },
	};
}

export async function createGitRepo(files: Readonly<Record<string, string>> = {}): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "agent-skills-verification-"));
	git(root, ["init", "--quiet"]);
	git(root, ["config", "user.name", "Verification Test"]);
	git(root, ["config", "user.email", "verification@example.invalid"]);
	await writeFile(path.join(root, "README.md"), "baseline\n");
	await mkdir(path.join(root, "src"), { recursive: true });
	await writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\n");
	await mkdir(path.join(root, ".omp"), { recursive: true });
	await writeFile(path.join(root, ".omp", "verification.json"), JSON.stringify(testPolicy(), null, 2));
	for (const [file, content] of Object.entries(files)) {
		const destination = path.join(root, file);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, content);
	}
	git(root, ["add", "-A"]);
	git(root, ["commit", "--quiet", "-m", "baseline"]);
	return root;
}

export function git(root: string, args: readonly string[], environment: Record<string, string | undefined> = process.env): string {
	return execFileSync("git", [...args], { cwd: root, env: environment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export async function dispose(root: string): Promise<void> {
	await rm(root, { recursive: true, force: true });
}

export async function writeRepoFile(root: string, file: string, content: string): Promise<void> {
	const destination = path.join(root, file);
	await mkdir(path.dirname(destination), { recursive: true });
	await writeFile(destination, content);
}
