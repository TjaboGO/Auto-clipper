import { spawn, SpawnOptionsWithoutStdio } from 'child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Run a command to completion, rejecting on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  options: SpawnOptionsWithoutStdio = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      reject(new Error(`failed to start "${cmd}": ${err.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`"${cmd} ${args.join(' ')}" exited with code ${code}\n${stderr.slice(-2000)}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}
