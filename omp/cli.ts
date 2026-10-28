// Thin entry for the work-state CLI: `bun omp/cli.ts <op> <args…>` prints the operation's output
// and exits with its code. The extension tool in index.ts is the normal way in; this is for tests.
import { runWorkState } from "./work-state";

const result = await runWorkState(process.argv.slice(2), {
	cwd: process.cwd(),
	onWrite: (stream, text) => (stream === "stdout" ? process.stdout : process.stderr).write(text),
});
process.exitCode = result.code;
